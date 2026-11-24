import type { CommandResult, MissionCommand, MissionSnapshot, MissionSource, Ms, Notice } from '../mission-stream'
import {
  DEFAULT_CONTEXT,
  DEFAULT_INSTRUCTION,
  PRESETS,
  cycleOf,
  sceneOf,
  snapshotOf,
  withEStop,
  withStop,
  type RunContext,
  type Scene,
} from './scenarios'
import { SITE } from './site-map'

export interface ReplayState {
  n: number
  label: string
  /** The brief's ★ states for this round */
  star: boolean
}

/** The prototype's scenario replay: the brief's 16 states, answering the operator's commands the way the mission
 * would, through the same contract as the backend, so the UI cannot tell them apart */
export interface ReplaySource extends MissionSource {
  readonly kind: 'replay'
  readonly states: readonly ReplayState[]
  /** Which of the brief's states is on screen, 0-based */
  index(): number
  /** Shows one of the brief's states as described, forgetting what the operator did since */
  go(index: number): void
  /** Stops the clock and every pending answer */
  close(): void
}

export function isReplaySource(source: MissionSource): source is ReplaySource {
  return source.kind === 'replay'
}

const TICK_MS = 1000
/** The planner writes a plan in about 5 s */
const PLAN_MS = 5000
/** A graceful stop ends when every robot has finished its waypoint: 10 s here, so Force stop shows for 2 s */
const STOP_ENDS_MS = 10_000
/** After CLEAR the dogs drive back to their slots; the replay skips to the end after a few seconds */
const RETURN_SKIP_MS = 6000
/** Every E-STOP answer is in after 3 s */
const ESTOP_ANSWERS_MS = [200, 400, 3000]

const presetOf = (n: number) => PRESETS.findIndex((p) => p.n === n)
const blocking = (notice: Notice) => (notice.fix ? `${notice.text}: ${notice.fix}` : notice.text)

/** Starts on one of the brief's states (1–16, default 1) */
export function createReplaySource(options: { state?: number; now?: () => Ms } = {}): ReplaySource {
  const now = options.now ?? Date.now
  const listeners = new Set<() => void>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let ticker: ReturnType<typeof setInterval> | null = null
  let presetIndex = 0
  let scene: Scene
  let estopAt: Ms | null = null
  let stop: { at: Ms; end: { at: Ms; forced: boolean } | null } | null = null
  let snapshot: MissionSnapshot
  let seq = 0

  const render = () => {
    let next = snapshotOf(scene, now(), ++seq)
    if (stop) next = withStop(next, stop.at, stop.end)
    if (estopAt !== null) next = withEStop(next, estopAt)
    snapshot = next
  }
  const emit = () => {
    render()
    listeners.forEach((listener) => listener())
  }
  const later = (ms: number, then: () => void) => {
    const id = setTimeout(() => {
      timers.delete(id)
      then()
      emit()
    }, ms)
    timers.add(id)
  }

  /** Moves the run to a moment of one of the brief's states; its clock restarts from that moment */
  const enter = (index: number, moment?: Partial<Scene> & { at: number }) => {
    timers.forEach(clearTimeout)
    timers.clear()
    presetIndex = index
    const preset = PRESETS[index]
    const t = now()
    // state 16 opens with every robot's answer already in
    estopAt = preset.estop && !moment ? t - ESTOP_ANSWERS_MS[ESTOP_ANSWERS_MS.length - 1] - 500 : null
    stop = null
    const base = sceneOf(preset, estopAt ?? t)
    scene = moment ? { ...base, ...moment, startedAt: t - moment.at * 1000 } : base
  }

  /** After E-STOP or Stop mission, nothing the run had scheduled happens any more */
  const halted = () => estopAt !== null || stop !== null
  const refuse = (reason: string): CommandResult => ({ ok: false, reason })
  const ok: CommandResult = { ok: true, reason: null }

  function apply(command: MissionCommand): CommandResult {
    const { run } = snapshot
    switch (command.type) {
      case 'estop':
        if (estopAt === null) estopAt = now()
        for (const ms of ESTOP_ANSWERS_MS) later(ms, () => undefined)
        return ok
      case 'start':
        if (run.status === 'running' || run.status === 'stopping') return refuse('The mission is already running')
        if (run.blockers.length) return refuse(blocking(run.blockers[0]))
        enter(presetOf(2), { at: 2, ctx: DEFAULT_CONTEXT, verdict: 'clear', notices: [] })
        return ok
      case 'stop':
        if (run.status !== 'running') return refuse('The mission is not running')
        stop = { at: now(), end: null }
        later(STOP_ENDS_MS, () => {
          if (stop && !stop.end) stop.end = { at: now(), forced: false }
        })
        return ok
      case 'force-stop':
        if (!stop || stop.end) return refuse('The mission is not stopping')
        if (now() - stop.at < snapshot.limits.forceStopAfterMs) return refuse('Force stop is offered 8 s after Stop mission')
        stop.end = { at: now(), forced: true }
        return ok
      case 'instruction': {
        if (run.awaiting !== 'instruction') return refuse('The mission is not waiting for an instruction')
        const text = command.text.trim()
        const ctx: RunContext = { ...scene.ctx, instruction: text || DEFAULT_INSTRUCTION, usedDefault: !text }
        const cycle = cycleOf(ctx)
        enter(presetOf(ctx.denied.length ? 5 : 3), { at: cycle.instruction + 1, ctx })
        later(PLAN_MS, () => halted() || enter(presetOf(4), { at: cycle.planReady + 1, ctx, notices: [] }))
        return ok
      }
      case 'decide-plan': {
        const waiting = snapshot.plans[snapshot.plans.length - 1]
        if (run.awaiting !== 'approval' || !waiting) return refuse('No plan is waiting for approval')
        if (command.plan !== waiting.n) return refuse(`Plan #${command.plan} is not the one waiting for approval`)
        if (command.decision === 'approve') {
          enter(presetOf(6), { at: cycleOf(scene.ctx).approved + 1, ctx: scene.ctx })
        } else {
          const ctx: RunContext = { ...scene.ctx, denied: [...scene.ctx.denied, scene.ctx.instruction] }
          enter(presetOf(5), { at: cycleOf(ctx).patrolFrom + 2, ctx })
        }
        return ok
      }
      case 'verdict': {
        if (run.awaiting !== 'verdict') return refuse('The contents photo is not in yet')
        const { ctx } = scene
        const cycle = cycleOf(ctx)
        if (command.value === 'anomaly') {
          enter(presetOf(14), { at: cycle.verdict + 2, ctx, verdict: 'anomaly' })
        } else {
          enter(presetOf(13), { at: cycle.verdict + 1, ctx, verdict: 'clear' })
          later(RETURN_SKIP_MS, () => halted() || enter(presetOf(13), { at: cycle.back + 2, ctx, verdict: 'clear' }))
        }
        return ok
      }
    }
  }

  enter(Math.max(0, presetOf(options.state ?? 1)))
  render()

  return {
    kind: 'replay',
    states: PRESETS.map(({ n, label, star }) => ({ n, label, star })),
    status: () => 'open',
    subscribe(listener) {
      listeners.add(listener)
      ticker ??= setInterval(emit, TICK_MS)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && ticker) {
          clearInterval(ticker)
          ticker = null
        }
      }
    },
    getSnapshot: () => snapshot,
    send(command) {
      const result = apply(command)
      emit()
      return Promise.resolve(result)
    },
    // the replay's ALOHA shares the dogs' map: its own map is the same ground with only its route
    siteMap: (map = 'dogs') =>
      Promise.resolve(
        map === 'aloha' ? { ...SITE, zones: [], box: null, routes: { patrol: {}, slots: [], sweep: {}, cordon: [], watch: null, aloha: SITE.routes.aloha } } : SITE,
      ),
    index: () => presetIndex,
    go(index) {
      enter(index)
      emit()
    },
    close() {
      timers.forEach(clearTimeout)
      timers.clear()
      if (ticker) clearInterval(ticker)
      ticker = null
    },
  }
}
