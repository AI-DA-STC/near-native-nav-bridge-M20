import { ROBOT_KEYS, type RobotKey } from '@/shared/config'
import type {
  AlohaFacts,
  EStopFacts,
  MissionEvent,
  MissionSnapshot,
  Ms,
  Notice,
  PhaseFacts,
  PhaseId,
  PlanFacts,
  RobotFacts,
  RouteFacts,
} from '../mission-stream'
import {
  CONTENTS,
  CONTENTS_TEXT,
  DETECT_FOUND_TEXT,
  DETECT_REFINED_TEXT,
  FOUND,
  PLAN_SR2,
  REFINED,
  T,
  alohaAt,
  dogAt,
  sweepEvents,
  sweepOutput,
  trailOf,
  type DogKey,
  type RouteAt,
  type TimedEvent,
  type TimedLine,
} from './mission-run'
import { BOX } from './site-map'

/* The replay's mock backend: the brief's 16 states as moments of a run, and the snapshot a backend would send at each */

export const DEFAULT_INSTRUCTION = 'Execute a systematic sweep of Zone A to scan for unattended or anomalous items'
const MISSION_NAME = 'Coordinated search & discovery'
const LIMITS = { poseStaleMs: 3000, forceStopAfterMs: 8000 }

/** A denied plan costs the run 63 s: 6 s to generate it, 16 s on screen, then 41 s of patrol until the next instruction */
const DENY_LOOP_S = 63
const DENIED_AFTER_S = 22
const PATROL_AGAIN_S = DENY_LOOP_S - DENIED_AFTER_S

/** What the operator said and decided in this run, carried from one state to the next */
export interface RunContext {
  /** The instruction the current plan answers, as sent */
  instruction: string
  usedDefault: boolean
  /** The instructions of the plans denied before it, oldest first */
  denied: string[]
}

export const DEFAULT_CONTEXT: RunContext = { instruction: DEFAULT_INSTRUCTION, usedDefault: true, denied: [] }

type NoticeKey = 'r2-missing' | 'busy-741' | 'no-video'

/** A moment of a run as the replay shows it: the robots stay where they are, the clocks keep ticking */
export interface Scene {
  /** Seconds from Start; negative before it */
  at: number
  /** The run's start on the backend's clock: the elapsed time keeps counting from `at` */
  startedAt: Ms
  ctx: RunContext
  verdict: 'clear' | 'anomaly'
  /** State 15: three docking corrections, still not docked after 90 s */
  dockingFails: boolean
  /** State 8: no video from R3's camera, try n of 3 */
  noVideo: number | null
  /** State 1: robot 665's bridge is down */
  r2Missing: boolean
  notices: NoticeKey[]
}

export interface ReplayPreset {
  n: number
  label: string
  /** The brief's ★ states for this round */
  star: boolean
  at: number
  ctx?: RunContext
  verdict?: 'clear' | 'anomaly'
  dockingFails?: boolean
  noVideo?: number
  r2Missing?: boolean
  notices?: NoticeKey[]
  /** State 16: E-STOP fired at this second, every robot has answered */
  estop?: boolean
}

/** The brief's section 5 */
export const PRESETS: readonly ReplayPreset[] = [
  { n: 1, label: 'Ready, R2 not connected', star: true, at: -1, r2Missing: true, notices: ['r2-missing'] },
  { n: 2, label: 'Patrol, lap 3, waiting for you', star: true, at: 84 },
  { n: 3, label: 'Formation, generating the plan', star: false, at: 91, notices: ['busy-741'] },
  { n: 4, label: 'Plan approval, waiting for you', star: true, at: 115 },
  {
    n: 5,
    label: 'Plan denied, back to Patrol',
    star: false,
    at: 154,
    ctx: { instruction: 'Sweep zones 1 and 3 first, keep R2 on the east wall', usedDefault: false, denied: [DEFAULT_INSTRUCTION] },
  },
  { n: 6, label: 'Sweep, R3 searching', star: false, at: 175 },
  { n: 7, label: 'Sweep, BOX FOUND, refined once', star: true, at: 246 },
  { n: 8, label: 'Sweep, no video, retrying 2/3', star: false, at: 190, noVideo: 2, notices: ['no-video'] },
  { n: 9, label: 'Cordon', star: false, at: 270 },
  { n: 10, label: 'ALOHA docking 2/3', star: false, at: 360 },
  { n: 11, label: 'Arms at pose 3, lid open', star: true, at: 392 },
  { n: 12, label: 'Verdict, waiting for you', star: true, at: 418 },
  { n: 13, label: 'Complete: CLEAR, 7:42', star: false, at: 470 },
  { n: 14, label: 'Ended: ANOMALY', star: false, at: 430, verdict: 'anomaly' },
  { n: 15, label: 'Failed: ALOHA not docked', star: false, at: 390, dockingFails: true },
  { n: 16, label: 'E-STOP fired during the sweep', star: true, at: 223, estop: true },
]

export function sceneOf(preset: ReplayPreset, now: Ms): Scene {
  return {
    at: preset.at,
    startedAt: now - preset.at * 1000,
    ctx: preset.ctx ?? DEFAULT_CONTEXT,
    verdict: preset.verdict ?? 'clear',
    dockingFails: preset.dockingFails ?? false,
    noVideo: preset.noVideo ?? null,
    r2Missing: preset.r2Missing ?? false,
    notices: preset.notices ?? [],
  }
}

/** When the current plan's cycle happens: each denied plan pushes it 63 s later */
export function cycleOf(ctx: RunContext) {
  const shift = ctx.denied.length * DENY_LOOP_S
  const instruction = T.instruction + shift
  return {
    shift,
    instruction,
    /** Patrol last started at Start, or when the last plan was denied */
    patrolFrom: ctx.denied.length ? instruction - PATROL_AGAIN_S : 0,
    planReady: T.planReady + shift,
    approved: T.approved + shift,
    verdict: T.verdict + shift,
    back: T.back + shift,
  }
}

const planId = (n: number) => `SR2-${String(n).padStart(2, '0')}`
const DOG_ID: Record<DogKey, string> = { r1: '741', r2: '665', r3: '738' }

const NOTICES: Record<NoticeKey, Omit<Notice, 'since'>> = {
  'r2-missing': { id: 'r2-missing', tone: 'fault', robot: 'r2', text: 'Robot 665 not connected', fix: 'is its bridge running?' },
  'busy-741': { id: 'busy-741', tone: 'warn', robot: 'r1', text: 'Robot 741 still busy with its previous task', fix: null },
  'no-video': { id: 'no-video', tone: 'warn', robot: 'r3', text: "No video from R3's camera, retrying 2/3", fix: null },
}

/** The run's history and the script's output, at their seconds from Start */
function historyOf(scene: Scene): { events: TimedEvent[]; lines: TimedLine[] } {
  const { ctx } = scene
  const c = cycleOf(ctx)
  const at = (s: number) => s + c.shift
  const instructionSent = (text: string, usedDefault: boolean): string =>
    usedDefault ? 'Instruction sent (default)' : `Instruction sent: “${text}”`
  const events: TimedEvent[] = [
    { s: 0, tag: 'OPERATOR', text: 'Mission started' },
    { s: 0, tag: 'FLEET', text: 'Patrol: R1, R2, R3 loop their perimeters' },
  ]
  const lines: TimedLine[] = [
    { s: 0, line: '=== Patrol: type the operator instruction and press ENTER at any time to break the loop ===' },
    { s: 0, line: '[FLEET] Sent: 741 (4 WP), 665 (4 WP), 738 (4 WP) are patrolling' },
  ]
  const planRequested = (s: number, instruction: string, usedDefault: boolean) => {
    events.push(
      { s, tag: 'OPERATOR', text: instructionSent(instruction, usedDefault) },
      { s, tag: 'FLEET', text: 'Formation: R1 → slot 1, R2 → slot 2, R3 → slot 3' },
    )
    lines.push(
      { s, line: `[DEMO] Operator: ${instruction}` },
      { s, line: '=== Formation: every robot to its slot in the line ===' },
      { s, line: '[FLEET] Sent: 741 (1 WP), 665 (1 WP), 738 (1 WP) are starting' },
      { s: s + 1, line: '[DEMO] Generating a plan...' },
    )
  }
  const planReady = (s: number, n: number) => {
    events.push({ s, tag: 'PLAN', text: `Plan ${planId(n)} ready · ${PLAN_SR2.title}` })
    lines.push(
      { s, line: `Plan ${planId(n)}: search zones 1–3 (${PLAN_SR2.summary})` },
      ...PLAN_SR2.steps.map((step) => ({ s, line: `${step.robot === 'aloha' ? 'ALOHA' : step.robot.toUpperCase()}: ${step.items.join(' → ')}` })),
      { s, line: 'Operator approval (approve/deny):' },
    )
  }
  ctx.denied.forEach((instruction, j) => {
    const asked = T.instruction + j * DENY_LOOP_S
    planRequested(asked, instruction, instruction === DEFAULT_INSTRUCTION)
    planReady(asked + (T.planReady - T.instruction), j + 1)
    const denied = asked + DENIED_AFTER_S
    events.push(
      { s: denied, tag: 'OPERATOR', text: `Plan ${planId(j + 1)} denied` },
      { s: denied, tag: 'FLEET', text: 'Patrol: R1, R2, R3 back on their loops' },
    )
    lines.push(
      { s: denied, line: `[DEMO] Plan ${planId(j + 1)} denied: back to patrolling` },
      { s: denied, line: '=== Patrol: type the operator instruction and press ENTER at any time to break the loop ===' },
    )
  })

  const n = ctx.denied.length + 1
  planRequested(c.instruction, ctx.instruction, ctx.usedDefault)
  planReady(c.planReady, n)
  events.push(
    { s: at(T.inSlots), tag: 'FLEET', text: 'R1, R2, R3 in their slots' },
    { s: c.approved, tag: 'OPERATOR', text: `Plan ${planId(n)} approved` },
    { s: c.approved, tag: 'FLEET', text: 'Sweep: 741, 665, 738 starting (3 WP each)' },
    { s: c.approved, tag: 'DETECT', text: "Watching R3's camera for the box" },
    ...sweepEvents().map((e) => ({ ...e, s: at(e.s) })),
  )
  lines.push(
    { s: c.approved, line: `[DEMO] Plan ${planId(n)} approved, waiting for every robot to reach its slot` },
    { s: c.approved, line: '=== Sweep: every robot sweeps its zone ===' },
    { s: c.approved, line: '[FLEET] Sent: 741 (3 WP), 665 (3 WP), 738 (3 WP) are starting' },
    { s: c.approved, line: "[DETECT] Watching robot 738's camera for the box (cpu)" },
    ...sweepOutput().map((l) => ({ ...l, s: at(l.s) })),
  )
  if (scene.noVideo) {
    events.push(
      { s: at(175), tag: 'DETECT', text: "No video from R3's camera, retrying 1/3" },
      { s: at(185), tag: 'DETECT', text: "No video from R3's camera, retrying 2/3" },
    )
    lines.push(
      { s: at(175), line: '[DETECT] [video] cannot open the stream of robot 738, retrying 1/3' },
      { s: at(185), line: '[DETECT] [video] cannot open the stream of robot 738, retrying 2/3' },
    )
    return { events, lines }
  }
  events.push(
    { s: at(T.found), tag: 'DETECT', text: DETECT_FOUND_TEXT },
    { s: at(T.refined), tag: 'DETECT', text: DETECT_REFINED_TEXT },
    { s: at(T.swept), tag: 'FLEET', text: 'Sweep done: every route finished' },
    { s: at(T.swept), tag: 'FLEET', text: 'Cordon: R1 and R2 to zone 3; R3 watches the item' },
    { s: at(270), tag: 'R3', text: 'Watching the item from x 6.14 y −0.17' },
    { s: at(285), tag: 'R1', text: 'At its cordon point' },
    { s: at(T.cordoned), tag: 'R2', text: 'At its cordon point' },
    { s: at(T.cordoned), tag: 'FLEET', text: 'Zone 3 cordoned off' },
    { s: at(T.cordoned), tag: 'ALOHA', text: 'Driving to the box' },
    { s: at(T.atBox), tag: 'ALOHA', text: 'At the box: docking, correction 1/3' },
    { s: at(T.atBox + 10), tag: 'ALOHA', text: 'Docking correction 2/3' },
    { s: at(T.atBox + 20), tag: 'ALOHA', text: 'Docking correction 3/3' },
  )
  lines.push(
    { s: at(T.found), line: `[DETECT] Box found by robot 738 at x=${FOUND.x} y=${FOUND.y} (map), ${FOUND.distM} m away, confidence ${FOUND.confidence}, image ${FOUND.path}` },
    { s: at(T.refined), line: `[DETECT] Box found by robot 738 at x=${REFINED.x} y=${REFINED.y} (map), ${REFINED.distM} m away, confidence ${REFINED.confidence}, image ${REFINED.path}` },
    { s: at(T.swept), line: "[DEMO] R3: suspicious item reported next to the box, watching it" },
    { s: at(T.swept), line: '=== Cordon: R1 and R2 cordon off zone 3 ===' },
    { s: at(T.cordoned), line: '[DEMO] Zone 3 cordoned off' },
    { s: at(T.cordoned), line: '=== Aloha: drive to the box, dock and open the lid ===' },
    { s: at(T.atBox), line: '[ALOHA] Robot aloha docking onto its last WP' },
  )
  if (scene.dockingFails) {
    events.push({ s: at(T.notDocked), tag: 'ALOHA', text: 'Not docked after 90 s: 3/3 corrections, still 0.42 m off' })
    lines.push({ s: at(T.notDocked), line: '[ERROR] Aloha: not docked after 90 s (3/3 corrections, still 0.42 m off)' })
    return { events, lines }
  }
  events.push(
    { s: at(T.docked), tag: 'ALOHA', text: 'Docked at the box' },
    { s: at(T.lidOpen), tag: 'ALOHA', text: 'Arms at pose 3/5: lid open, holding 5 s' },
    { s: at(T.photo), tag: 'INSPECT', text: CONTENTS_TEXT },
    { s: at(T.armsDone), tag: 'ALOHA', text: 'Arms done: pose 5/5' },
  )
  lines.push(
    ...[375, 383, T.lidOpen, 400, 408].map((s, i) => ({ s: at(s), line: `Pose ${i + 1}/5` })),
    {
      s: at(T.photo),
      line: `[INSPECT] Box contents: ${CONTENTS.objects.map((o) => `${o.label} ${o.confidence.toFixed(2)}`).join(', ')}; image ${CONTENTS.path}`,
    },
    { s: at(T.armsDone), line: '[DEMO] ALOHA done at the box' },
    { s: at(T.armsDone), line: "=== Verdict: the operator marks the box's contents ===" },
    { s: at(T.armsDone), line: 'Operator verdict (anomaly/clear):' },
  )
  const word = scene.verdict.toUpperCase()
  events.push({ s: c.verdict, tag: 'OPERATOR', text: `Verdict: ${word}` })
  lines.push({ s: c.verdict, line: `[DEMO] Operator verdict: ${word}` })
  if (scene.verdict === 'anomaly') {
    events.push({ s: c.verdict, tag: 'FLEET', text: 'Mission ended on the verdict: the dogs hold the cordon' })
    return { events, lines }
  }
  events.push(
    { s: c.verdict, tag: 'FLEET', text: 'Return to formation: R1, R2, R3 to their slots' },
    { s: c.back, tag: 'FLEET', text: 'R1, R2, R3 back in formation' },
    { s: c.back, tag: 'PLAN', text: `Plan ${planId(n)} completed` },
  )
  lines.push(
    { s: c.verdict, line: '=== Return to formation: every robot back to its slot in the line ===' },
    { s: c.back, line: '[DEMO] Every robot back in formation' },
  )
  return { events, lines }
}

/** The snapshot the backend would send at `serverTime`, while the run shows the scene's moment */
export function snapshotOf(scene: Scene, serverTime: Ms, seq: number): MissionSnapshot {
  const { ctx } = scene
  const s = scene.at
  const c = cycleOf(ctx)
  const ms = (sec: number) => scene.startedAt + sec * 1000
  const started = s >= 0
  // the nominal run's second whose robots and findings the scene shows
  const nominal = c.shift && s >= c.patrolFrom ? s - c.shift : s
  const toScene = (sec: number) => sec + (s - nominal)
  const failedAt = scene.dockingFails ? T.notDocked + c.shift : null
  const endS = failedAt ?? (scene.verdict === 'anomaly' ? c.verdict : c.back)
  const ended = started && s >= endS
  const ending = { verdict: scene.verdict }

  const spans: Array<[PhaseId, number, number]> = [
    ['patrol', c.patrolFrom, c.instruction],
    ['formation', c.instruction, c.planReady],
    ['approval', c.planReady, c.approved],
    ['sweep', c.approved, T.swept + c.shift],
    ['cordon', T.swept + c.shift, T.cordoned + c.shift],
    ['inspect', T.cordoned + c.shift, T.armsDone + c.shift],
    ['verdict', T.armsDone + c.shift, c.verdict],
    ['return', c.verdict, c.back],
  ]
  const phases: PhaseFacts[] = [
    started
      ? { id: 'ready', status: 'done', startedAt: ms(0), endedAt: ms(0), detail: '' }
      : { id: 'ready', status: 'active', startedAt: null, endedAt: null, detail: 'Bring-up: bridges, positions, ALOHA' },
    ...spans.map(([id, from, to]): PhaseFacts => {
      if (failedAt !== null && id === 'inspect' && s >= failedAt) {
        return { id, status: 'failed', startedAt: ms(from), endedAt: ms(failedAt), detail: 'ALOHA not docked after 90 s' }
      }
      if (failedAt !== null && s >= failedAt && from >= failedAt) return { id, status: 'pending', startedAt: null, endedAt: null, detail: '' }
      if (id === 'return' && scene.verdict === 'anomaly' && s >= c.verdict) {
        return { id, status: 'skipped', startedAt: null, endedAt: null, detail: 'Not run after ANOMALY' }
      }
      if (!started || s < from) return { id, status: 'pending', startedAt: null, endedAt: null, detail: '' }
      if (s < to) return { id, status: 'active', startedAt: ms(from), endedAt: null, detail: '' }
      return { id, status: 'done', startedAt: ms(from), endedAt: ms(to), detail: '' }
    }),
  ]
  const active = phases.find((p) => p.status === 'active')?.id

  const routeOf = (route: RouteAt | null): RouteFacts | null =>
    route && { ...route, last: route.last && { ...route.last, at: ms(toScene(route.last.at)) } }
  const fresh = serverTime - 150
  const dog = (key: DogKey): RobotFacts => {
    if (key === 'r2' && scene.r2Missing) return { id: DOG_ID.r2, inMission: true, domain: 0, bridge: 'disconnected', pose: null, speed: null, trail: [], route: null }
    const m = dogAt(key, nominal, ending)
    return {
      id: DOG_ID[key],
      inMission: true,
      domain: 0,
      bridge: 'connected',
      pose: { x: m.p[0], y: m.p[1], yawDeg: m.yaw, at: fresh },
      speed: m.speed,
      trail: started ? trailOf((t) => dogAt(key, t, ending).p, nominal) : [],
      route: routeOf(m.route),
    }
  }
  const a = alohaAt(nominal, scene.dockingFails)
  const aloha: AlohaFacts = {
    id: '',
    inMission: true,
    sameMap: true,
    domain: 1,
    bridge: 'connected',
    pose: { x: a.p[0], y: a.p[1], yawDeg: a.yaw, at: fresh },
    speed: a.speed,
    trail: started ? trailOf((t) => alohaAt(t, scene.dockingFails).p, nominal) : [],
    route: routeOf(a.route),
    nav: 'ready',
    docking: {
      attempt: a.docking.attempt,
      of: 3,
      state: a.docking.state,
      reason: a.docking.state === 'failed' ? '3/3 corrections, still 0.42 m off' : null,
    },
    arms: { pose: a.arms.pose, of: 5, state: a.arms.state, holdEndsAt: a.holdEndsAt === null ? null : ms(toScene(a.holdEndsAt)) },
  }

  const found = !scene.noVideo && started && nominal >= T.found
  const refined = found && nominal >= T.refined
  const sighting = refined ? REFINED : FOUND
  const detection: MissionSnapshot['detection'] = found
    ? {
        by: 'r3',
        x: sighting.x,
        y: sighting.y,
        distM: sighting.distM,
        confidence: sighting.confidence,
        uncertaintyM: sighting.uncertaintyM,
        size: { w: BOX.w, h: BOX.h },
        foundAt: ms(toScene(T.found)),
        refinedAt: refined ? ms(toScene(T.refined)) : null,
        refinements: refined ? 1 : 0,
        snapshot: { url: sighting.frame, box: sighting.box, path: sighting.path },
      }
    : null
  const photoIn = !scene.dockingFails && started && nominal >= T.photo
  const contents: MissionSnapshot['contents'] = photoIn
    ? { state: 'ready', photo: { url: CONTENTS.photo, at: ms(toScene(T.photo)), path: CONTENTS.path }, objects: CONTENTS.objects }
    : { state: !scene.dockingFails && nominal >= T.lidOpen ? 'capturing' : 'waiting', photo: null, objects: [] }

  const n = ctx.denied.length + 1
  const plans: PlanFacts[] = ctx.denied.map((instruction, j) => ({
    n: j + 1,
    id: planId(j + 1),
    title: PLAN_SR2.title,
    summary: PLAN_SR2.summary,
    instruction,
    status: 'denied',
    steps: PLAN_SR2.steps,
    createdAt: ms(T.planReady + j * DENY_LOOP_S),
    decidedAt: ms(T.instruction + j * DENY_LOOP_S + DENIED_AFTER_S),
  }))
  if (started && s >= c.instruction) {
    plans.push(
      s < c.planReady
        ? { n, id: null, title: null, summary: null, instruction: ctx.instruction, status: 'generating', steps: [], createdAt: ms(c.instruction), decidedAt: null }
        : {
            n,
            id: planId(n),
            title: PLAN_SR2.title,
            summary: PLAN_SR2.summary,
            instruction: ctx.instruction,
            status: s < c.approved ? 'awaiting' : ended ? (failedAt !== null ? 'failed' : 'completed') : 'executing',
            steps: PLAN_SR2.steps,
            createdAt: ms(c.planReady),
            decidedAt: s >= c.approved ? ms(c.approved) : null,
          },
    )
  }
  const lastDenied = ctx.denied[ctx.denied.length - 1]
  const instruction: MissionSnapshot['instruction'] =
    started && s >= c.instruction
      ? { text: ctx.instruction, usedDefault: ctx.usedDefault, at: ms(c.instruction) }
      : lastDenied !== undefined
        ? { text: lastDenied, usedDefault: lastDenied === DEFAULT_INSTRUCTION, at: ms(c.instruction - DENY_LOOP_S) }
        : null

  const notices = scene.notices.map((key): Notice => ({ ...NOTICES[key], since: ms(Math.max(s - 6, 0)) }))
  const { events, lines } = historyOf(scene)
  const timeline: MissionEvent[] = events
    .filter((e) => started && e.s <= s)
    .sort((x, y) => x.s - y.s)
    .map((e, i) => ({ id: `e${i}-${e.s}`, at: ms(e.s), tag: e.tag, text: e.text }))
  const output = lines
    .filter((l) => started && l.s <= s)
    .sort((x, y) => x.s - y.s)
    .map((l) => l.line)

  return {
    seq,
    serverTime,
    limits: LIMITS,
    mission: { name: MISSION_NAME, defaultInstruction: DEFAULT_INSTRUCTION },
    run: {
      status: !started ? 'idle' : ended ? 'ended' : 'running',
      outcome: !ended ? null : failedAt !== null ? 'failed' : scene.verdict === 'anomaly' ? 'anomaly' : 'complete',
      reason: ended && failedAt !== null ? 'ALOHA not docked after 90 s' : null,
      startedAt: started ? ms(0) : null,
      endedAt: ended ? ms(endS) : null,
      stopRequestedAt: null,
      awaiting:
        !started || ended
          ? null
          : active === 'patrol'
            ? 'instruction'
            : active === 'approval'
              ? 'approval'
              : photoIn && s < c.verdict
                ? 'verdict'
                : null,
      blockers: started ? [] : notices.filter((x) => x.tone === 'fault'),
    },
    phases,
    instruction,
    plans,
    robots: { r1: dog('r1'), r2: dog('r2'), r3: dog('r3'), aloha },
    detection,
    contents,
    verdict: ended || s >= c.verdict ? (failedAt === null ? { value: scene.verdict, at: ms(c.verdict) } : null) : null,
    warnings: notices,
    estop: null,
    timeline,
    output,
  }
}

/* What the operator's E-STOP and Stop mission do to whatever the run was doing */

/** How each robot answers an E-STOP in the replay: R2 never does (the brief's state 16) */
const ESTOP_ANSWERS: Record<RobotKey, { latencyMs: number | null; reason: string | null }> = {
  r1: { latencyMs: 210, reason: null },
  r2: { latencyMs: null, reason: 'no answer' },
  r3: { latencyMs: 340, reason: null },
  aloha: { latencyMs: 180, reason: null },
}

function haltRun(snap: MissionSnapshot, at: Ms, outcome: 'stopped' | 'estopped', reason: string): MissionSnapshot {
  const halt = <R extends RobotFacts>(r: R): R => ({
    ...r,
    speed: r.pose ? 0 : r.speed,
    route: r.route && r.route.state === 'driving' ? { ...r.route, state: 'stopped' } : r.route,
  })
  const running = snap.run.status === 'running' || snap.run.status === 'stopping'
  return {
    ...snap,
    run: running ? { ...snap.run, status: 'ended', outcome, reason, endedAt: at, awaiting: null } : snap.run,
    phases: running ? snap.phases.map((p) => (p.status === 'active' ? { ...p, status: 'stopped', endedAt: at } : p)) : snap.phases,
    plans: snap.plans.map((p) => (['generating', 'awaiting', 'executing'].includes(p.status) ? { ...p, status: 'stopped' } : p)),
    robots: {
      r1: halt(snap.robots.r1),
      r2: halt(snap.robots.r2),
      r3: halt(snap.robots.r3),
      aloha: { ...halt(snap.robots.aloha), arms: snap.robots.aloha.arms.state === 'moving' || snap.robots.aloha.arms.state === 'holding' ? { ...snap.robots.aloha.arms, state: 'stopped' } : snap.robots.aloha.arms },
    },
  }
}

/** The E-STOP banner's rows `elapsedMs` after it fired: the answers arrive within a few hundred ms, and a robot that has
 * not answered after 3 s is NOT CONFIRMED */
export function estopResults(elapsedMs: number): EStopFacts['results'] {
  return ROBOT_KEYS.map((robot) => {
    const answer = ESTOP_ANSWERS[robot]
    if (answer.latencyMs !== null && elapsedMs >= answer.latencyMs) return { robot, state: 'confirmed', latencyMs: answer.latencyMs, reason: null }
    if (answer.latencyMs === null && elapsedMs >= 3000) return { robot, state: 'unconfirmed', latencyMs: null, reason: answer.reason }
    return { robot, state: 'pending', latencyMs: null, reason: null }
  })
}

export function withEStop(snap: MissionSnapshot, firedAt: Ms): MissionSnapshot {
  const results = estopResults(snap.serverTime - firedAt)
  const halted = haltRun(snap, firedAt, 'estopped', 'E-STOP')
  const answers: MissionEvent[] = results
    .filter((r) => r.state !== 'pending')
    .map((r) => ({
      id: `estop-${r.robot}`,
      at: firedAt + (r.latencyMs ?? 3000),
      tag: 'ESTOP',
      text: r.state === 'confirmed' ? `${r.robot === 'aloha' ? 'ALOHA' : r.robot.toUpperCase()} confirmed · ${r.latencyMs} ms` : `${r.robot.toUpperCase()} NOT CONFIRMED (${r.reason})`,
    }))
  return {
    ...halted,
    estop: { firedAt, results },
    timeline: [...halted.timeline, { id: 'estop', at: firedAt, tag: 'ESTOP', text: 'E-STOP sent to every robot' }, ...answers],
  }
}

/** Stop mission: stopping until the script ends (or Force stop), then ended */
export function withStop(snap: MissionSnapshot, requestedAt: Ms, end: { at: Ms; forced: boolean } | null): MissionSnapshot {
  if (snap.run.status !== 'running' && snap.run.status !== 'stopping') return snap
  const asked: MissionEvent = { id: 'stop', at: requestedAt, tag: 'OPERATOR', text: 'Stop mission: no new waypoints; each robot finishes the one it is driving to' }
  if (!end) {
    return {
      ...snap,
      run: { ...snap.run, status: 'stopping', stopRequestedAt: requestedAt, awaiting: null },
      timeline: [...snap.timeline, asked],
      output: [...snap.output, '^C'],
    }
  }
  const halted = haltRun(snap, end.at, 'stopped', end.forced ? 'Force stopped: the script had not ended 8 s after Stop' : 'Stopped by the operator')
  return {
    ...halted,
    run: { ...halted.run, stopRequestedAt: requestedAt },
    timeline: [
      ...halted.timeline,
      asked,
      { id: 'stopped', at: end.at, tag: end.forced ? 'OPERATOR' : 'FLEET', text: end.forced ? 'Force stop: the script was killed' : 'Mission stopped' },
    ],
    output: [...halted.output, '^C'],
  }
}

