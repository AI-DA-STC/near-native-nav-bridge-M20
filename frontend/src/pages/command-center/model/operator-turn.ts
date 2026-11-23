import type { MissionSnapshot, PhaseId, PlanFacts, PlanStatusKey } from '@/shared/api'
import { FLEET, type RobotKey } from '@/shared/config'
import { formatDuration, formatNumber, formatPercent, formatTimeOfDay } from '@/shared/lib'
import type { StepStatus } from '@/shared/ui/StatusMark'
import { bringUpOf, PHASES } from './phase-track'

export interface PlanView {
  n: number
  id: string
  title: string
  summary: string
  status: PlanStatusKey
  /** The instruction it answers, verbatim */
  instruction: string
  /** Exactly as the planner wrote them, each with its mark once the plan runs */
  steps: Array<{ robot: RobotKey; items: Array<{ text: string; status: StepStatus }> }>
}

export type Outcome = 'complete' | 'anomaly' | 'failed' | 'stopped' | 'estopped'

/** A dog that did not reach its formation slot: its one waypoint ended STOPPED SHORT or TIMEOUT */
export interface ShortOfSlot {
  robot: 'r1' | 'r2' | 'r3'
  /** 1, 2 or 3 */
  slot: number
  outcome: 'aborted' | 'timeout'
}

/** What the Operator panel shows: it follows the mission, and is the one hot panel when it is the operator's turn */
export type OperatorTurn =
  | { kind: 'start'; hot: boolean; detail: string; steps: Array<{ label: string; status: 'done' | 'failed' }> }
  | { kind: 'instruction'; placeholder: string }
  | { kind: 'generating'; planNumber: number }
  | { kind: 'approval'; plan: PlanView; shortOfSlot: ShortOfSlot[] }
  | { kind: 'running'; eyebrow: string; question: string; detail: string }
  | { kind: 'verdict'; decided: { value: 'anomaly' | 'clear'; at: string } | null }
  | { kind: 'outcome'; outcome: Outcome; verdict: 'anomaly' | 'clear' | null; total: string | null; reason: string | null; facts: Array<{ label: string; value: string; mono?: boolean }> }

const phaseStatus = (snap: MissionSnapshot, id: PhaseId): StepStatus => snap.phases.find((p) => p.id === id)?.status ?? 'pending'

/** A step that spans several phases: active while any of them is, done once the last is */
function spanStatus(snap: MissionSnapshot, ids: PhaseId[]): StepStatus {
  const all = ids.map((id) => phaseStatus(snap, id))
  for (const status of ['failed', 'stopped', 'active'] as const) if (all.includes(status)) return status
  return all[all.length - 1] === 'done' || all[all.length - 1] === 'skipped' ? 'done' : 'pending'
}

const DOG_STEPS: Array<(snap: MissionSnapshot) => StepStatus> = [
  (s) => phaseStatus(s, 'sweep'),
  (s) => spanStatus(s, ['cordon', 'inspect', 'verdict']),
  (s) => phaseStatus(s, 'return'),
  () => 'pending',
]

/** Which part of the mission each step of plan SR2 is, by its position in the robot's list */
const STEPS: Record<RobotKey, Array<(snap: MissionSnapshot) => StepStatus>> = {
  r1: DOG_STEPS,
  r2: DOG_STEPS,
  r3: [
    (s) => phaseStatus(s, 'sweep'),
    (s) => (s.detection ? 'done' : 'pending'),
    (s) => spanStatus(s, ['cordon', 'inspect', 'verdict']),
    (s) => phaseStatus(s, 'return'),
    () => 'pending',
  ],
  aloha: [
    (s) => (phaseStatus(s, 'inspect') !== 'pending' ? 'done' : spanStatus(s, ['sweep', 'cordon'])),
    (s) => {
      const { route, docking } = s.robots.aloha
      return docking.state !== 'idle' ? 'done' : route?.state === 'driving' ? 'active' : route?.state === 'stopped' ? 'stopped' : 'pending'
    },
    (s) => {
      const { docking, arms } = s.robots.aloha
      return arms.pose >= 3 ? 'done' : docking.state === 'docked' ? 'active' : 'pending'
    },
    (s) => (s.contents.state === 'ready' ? 'done' : s.contents.state === 'capturing' ? 'active' : 'pending'),
    (s) => {
      const { docking } = s.robots.aloha
      return docking.state === 'docked' ? 'done' : docking.state === 'failed' ? 'failed' : docking.state === 'active' ? 'active' : 'pending'
    },
  ],
}

export function planViewOf(plan: PlanFacts, snap: MissionSnapshot): PlanView {
  const running = plan.status !== 'awaiting' && plan.status !== 'denied' && plan.status !== 'generating'
  return {
    n: plan.n,
    id: plan.id ?? '',
    title: plan.title ?? '',
    summary: plan.summary ?? '',
    status: plan.status,
    instruction: plan.instruction,
    steps: plan.steps.map((step) => ({
      robot: step.robot,
      items: step.items.map((text, i) => ({ text, status: running ? (STEPS[step.robot][i]?.(snap) ?? 'pending') : 'pending' })),
    })),
  }
}

/** The dogs the formation left short of their slot; they start the sweep from where they stopped */
export function shortOfSlotOf(snap: MissionSnapshot): ShortOfSlot[] {
  return (['r1', 'r2', 'r3'] as const).flatMap((robot, i) => {
    const route = snap.robots[robot].route
    const outcome = route?.kind === 'formation' ? route.last?.outcome : undefined
    return outcome === 'aborted' || outcome === 'timeout' ? [{ robot, slot: i + 1, outcome }] : []
  })
}

const sayList = (labels: string[]) => (labels.length < 2 ? labels.join('') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`)

function startTurn(snap: MissionSnapshot): OperatorTurn {
  const b = bringUpOf(snap)
  const ready = (['r1', 'r2', 'r3'] as const)
    .filter((k) => snap.robots[k].inMission && snap.robots[k].bridge === 'connected' && snap.robots[k].pose)
    .map((k) => FLEET[k].label)
  const hot = snap.run.blockers.length === 0
  return {
    kind: 'start',
    hot,
    detail: hot
      ? `Bring-up is done: every nav bridge listens, positions are arriving${b.alohaIn ? ' and the ALOHA is ready' : ''}.`
      : `${ready.length ? `${sayList(ready)} ${ready.length === 1 ? 'is' : 'are'} connected and placed${b.alohaIn && b.aloha ? ', the ALOHA is ready' : ''}. ` : ''}Missing:`,
    steps: [
      { label: `Bridges ${b.connected}/${b.of}`, status: b.connected === b.of ? 'done' : 'failed' },
      { label: `Positions ${b.placed}/${b.of}`, status: b.placed === b.of ? 'done' : 'failed' },
      ...(b.alohaIn ? [{ label: 'ALOHA', status: b.aloha ? ('done' as const) : ('failed' as const) }] : []),
    ],
  }
}

const NEXT_VERDICT = 'Next decision · Verdict'

function runningTurn(snap: MissionSnapshot, active: PhaseId | undefined): OperatorTurn {
  const { detection, robots } = snap
  if (snap.run.status === 'stopping') {
    return { kind: 'running', eyebrow: 'Stopping', question: 'Stopping: no new waypoints are sent.', detail: 'Each robot finishes the waypoint it is driving to; the ALOHA’s arms freeze where they are.' }
  }
  switch (active) {
    case 'sweep':
      return {
        kind: 'running',
        eyebrow: NEXT_VERDICT,
        question: detection ? 'Sweep running: R3 has found the box.' : 'Sweep running: every robot sweeps its zone.',
        detail: 'Cordon follows when every route is done; then the ALOHA drives to the box and photographs the contents. You give the verdict.',
      }
    case 'cordon':
      return {
        kind: 'running',
        eyebrow: NEXT_VERDICT,
        question: 'Cordon: R1 and R2 are closing off zone 3.',
        detail: 'R3 watches the item. Then the ALOHA drives to the box, docks and opens the lid; you give the verdict on what is inside.',
      }
    case 'inspect': {
      const { docking, arms } = robots.aloha
      const question =
        arms.state === 'holding'
          ? 'Lid open: holding 5 s for the photo.'
          : arms.pose > 0
            ? `The ALOHA is opening the lid: arm pose ${arms.pose} of ${arms.of}.`
            : docking.state === 'active'
              ? `The ALOHA is docking: correction ${docking.attempt} of ${docking.of}.`
              : 'The ALOHA is driving to the box.'
      return { kind: 'running', eyebrow: NEXT_VERDICT, question, detail: 'At arm pose 3 the lid is open and held 5 s for one photo. You give the verdict as soon as the photo is in.' }
    }
    default:
      return { kind: 'running', eyebrow: 'Mission running', question: 'The robots carry out the plan.', detail: '' }
  }
}

function outcomeTurn(snap: MissionSnapshot): OperatorTurn {
  const { run, detection, contents, estop, verdict } = snap
  const outcome = (run.outcome ?? 'stopped') as Outcome
  const total = run.startedAt !== null && run.endedAt !== null ? formatDuration(run.endedAt - run.startedAt) : null
  const halted = snap.phases.find((p) => p.status === 'failed' || p.status === 'stopped')
  const phaseName = halted ? `${PHASES.find((p) => p.id === halted.id)?.n} · ${PHASES.find((p) => p.id === halted.id)?.name}` : null
  const boxAt = detection ? [{ label: 'Box at', value: `(${formatNumber(detection.x)}, ${formatNumber(detection.y)})`, mono: true }] : []
  const objects = [...contents.objects].sort((a, b) => b.confidence - a.confidence)
  const facts: Array<{ label: string; value: string; mono?: boolean }> = []
  let reason: string | null = null
  switch (outcome) {
    case 'complete': {
      const denied = snap.plans.filter((p) => p.status === 'denied').length
      facts.push(...boxAt, { label: 'Contents', value: objects.map((o) => o.label).join(', ') || '—' })
      facts.push({ label: 'Plans', value: denied ? `${snap.plans.length} · ${denied} denied` : `${snap.plans.length} · approved` })
      facts.push({ label: 'Back in slots', value: `${(['r1', 'r2', 'r3'] as const).filter((k) => snap.robots[k].route?.kind === 'return' && snap.robots[k].route?.state === 'finished').length}/3` })
      break
    }
    case 'anomaly':
      reason = 'Ended on the verdict. Return to formation skipped; the dogs hold the cordon.'
      facts.push(...boxAt)
      if (objects[0]) facts.push({ label: 'Contents', value: `${objects[0].label} ${formatPercent(objects[0].confidence)}` })
      break
    case 'failed': {
      const docking = snap.robots.aloha.docking.reason
      reason = `${run.reason ?? 'The mission failed'}${docking ? `: ${docking}` : ''}.`
      if (phaseName) facts.push({ label: 'Failed in', value: phaseName })
      facts.push(...boxAt)
      break
    }
    case 'stopped':
      reason = run.reason
      if (phaseName) facts.push({ label: 'Stopped in', value: phaseName })
      facts.push(...boxAt)
      break
    case 'estopped':
      reason = 'E-STOP: every robot was told to stop at once.'
      if (phaseName) facts.push({ label: 'Stopped in', value: phaseName })
      if (estop) facts.push({ label: 'Confirmed', value: `${estop.results.filter((r) => r.state === 'confirmed').length}/${estop.results.length}` })
      break
  }
  return { kind: 'outcome', outcome, verdict: verdict?.value ?? null, total, reason, facts }
}

export function operatorTurnOf(snap: MissionSnapshot): OperatorTurn {
  const { run, plans, verdict } = snap
  if (run.status === 'idle') return startTurn(snap)
  if (run.status === 'ended') return outcomeTurn(snap)
  const plan = plans[plans.length - 1]
  const active = snap.phases.find((p) => p.status === 'active')?.id
  if (run.awaiting === 'instruction') return { kind: 'instruction', placeholder: snap.mission.defaultInstruction }
  if (run.awaiting === 'approval' && plan) return { kind: 'approval', plan: planViewOf(plan, snap), shortOfSlot: shortOfSlotOf(snap) }
  if (run.awaiting === 'verdict') return { kind: 'verdict', decided: null }
  if (verdict && run.status === 'running') return { kind: 'verdict', decided: { value: verdict.value, at: formatTimeOfDay(verdict.at) } }
  if (plan?.status === 'generating') return { kind: 'generating', planNumber: plan.n }
  return runningTurn(snap, active)
}

/** The operator's turn: the Operator panel is hot and the state chip says WAITING FOR YOU */
export function isOperatorsTurn(turn: OperatorTurn): boolean {
  return turn.kind === 'instruction' || turn.kind === 'approval' || (turn.kind === 'verdict' && !turn.decided) || (turn.kind === 'start' && turn.hot)
}
