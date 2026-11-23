import type { MissionSnapshot, PhaseFacts, PhaseId, PhaseStatus } from '@/shared/api'
import type { RobotKey } from '@/shared/config'
import { formatDuration } from '@/shared/lib'
import { robotStateOf } from './robot-state'
import { routeProgress, waypointsDone } from './route-progress'

/** The mission's phases, 0 Ready … 8 Return to formation; the operator decides in the two marked ◆ YOU */
export const PHASES: ReadonlyArray<{ id: PhaseId; n: number; name: string; decision: boolean }> = [
  { id: 'ready', n: 0, name: 'Ready', decision: false },
  { id: 'patrol', n: 1, name: 'Patrol', decision: false },
  { id: 'formation', n: 2, name: 'Formation', decision: false },
  { id: 'approval', n: 3, name: 'Plan approval', decision: true },
  { id: 'sweep', n: 4, name: 'Sweep', decision: false },
  { id: 'cordon', n: 5, name: 'Cordon', decision: false },
  { id: 'inspect', n: 6, name: 'ALOHA inspection', decision: false },
  { id: 'verdict', n: 7, name: 'Verdict', decision: true },
  { id: 'return', n: 8, name: 'Return to formation', decision: false },
]

const DOGS = ['r1', 'r2', 'r3'] as const

export type PhaseNote = string | { verdict: 'anomaly' | 'clear' }

export interface TrackPhase {
  id: PhaseId
  n: number
  name: string
  decision: boolean
  status: PhaseStatus
  /** The duration once over, the elapsed time while active: "1:47" */
  time: string | null
  /** "Approved", "Denied ×1", a failure's reason, or the verdict */
  note: PhaseNote | null
  /** The operator's part in a phase that is not a decision: "Your instruction" */
  turn: string | null
  /** 0–1: the active phase's rail */
  progress: number | null
  /** Live sub-progress: per robot ("WP 2/3"), or one line */
  sub: Array<{ robot: RobotKey; text: string }> | string | null
  /** BOX FOUND, with the time into the sweep */
  finding: { label: string; at: string } | null
}

export interface PhaseTrackView {
  phases: TrackPhase[]
  /** A denied plan's loop back to Patrol, with its count */
  loops: Array<{ from: PhaseId; to: PhaseId; count: number }>
  /** Once the mission has ended, its total time: "7:42" */
  total: string | null
}

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0)

function timeOf(phase: PhaseFacts, snap: MissionSnapshot): string | null {
  if (phase.startedAt === null) return null
  if (phase.status === 'active') return formatDuration(snap.serverTime - phase.startedAt)
  return phase.endedAt === null ? null : formatDuration(phase.endedAt - phase.startedAt)
}

/** The bring-up before Start, for the robots in this mission: nav bridges, positions, the ALOHA */
export function bringUpOf(snap: MissionSnapshot) {
  const { robots, serverTime, limits } = snap
  const dogs = DOGS.filter((k) => robots[k].inMission)
  const connected = dogs.filter((k) => robots[k].bridge === 'connected').length
  const placed = dogs.filter((k) => {
    const pose = robots[k].pose
    return pose !== null && serverTime - pose.at <= limits.poseStaleMs
  }).length
  const alohaIn = robots.aloha.inMission
  const aloha = !alohaIn || (robots.aloha.bridge === 'connected' && robots.aloha.nav === 'ready')
  return { connected, placed, of: dogs.length, aloha, alohaIn }
}

function progressOf(id: PhaseId, snap: MissionSnapshot): number | null {
  const { robots } = snap
  const dogs = DOGS.map((k) => robots[k].route)
  switch (id) {
    case 'ready': {
      const b = bringUpOf(snap)
      return (b.connected + b.placed + Number(b.aloha)) / (2 * b.of + 1)
    }
    case 'sweep': {
      const routes = dogs.filter((r) => r?.kind === 'sweep')
      const total = routes.reduce((n, r) => n + (r?.total ?? 0), 0)
      return total ? routes.reduce((n, r) => n + (r ? waypointsDone(r) : 0), 0) / total : 0
    }
    case 'inspect': {
      const { route, docking, arms } = robots.aloha
      const drive = route?.kind === 'aloha' ? (docking.state === 'idle' ? routeProgress(route) * 0.9 : 1) : 0
      const docked = docking.state === 'docked' ? 1 : docking.attempt / (docking.of + 1)
      return (drive + docked + arms.pose / arms.of) / 3
    }
    case 'verdict':
      return null
    default:
      return mean(dogs.map((r) => routeProgress(r)))
  }
}

function subOf(id: PhaseId, snap: MissionSnapshot): TrackPhase['sub'] {
  const { robots } = snap
  const perDog = (text: (k: (typeof DOGS)[number]) => string | null) =>
    DOGS.flatMap((robot) => {
      const t = text(robot)
      return t ? [{ robot, text: t }] : []
    })
  const inSlot = (k: (typeof DOGS)[number]) => (robots[k].route?.state === 'finished' ? 'in slot' : 'to slot')
  const plan = snap.plans[snap.plans.length - 1]
  switch (id) {
    case 'ready': {
      const b = bringUpOf(snap)
      return `Fleet ${b.connected}/${b.of} · Positions ${b.placed}/${b.of}${b.alohaIn ? ` · ALOHA ${b.aloha ? 'ready' : 'not ready'}` : ''}`
    }
    case 'patrol':
      return perDog((k) => (robots[k].route?.lap ? `lap ${robots[k].route?.lap}` : null))
    case 'formation':
      if (plan?.status === 'generating') return plan.n > 1 ? `Generating plan #${plan.n}…` : 'Generating plan…'
      return perDog(inSlot)
    case 'approval':
    case 'return':
      return perDog(inSlot)
    case 'sweep':
      return perDog((k) => {
        const route = robots[k].route
        if (route?.kind !== 'sweep') return null
        return route.state === 'finished' || route.target === null ? 'done' : `WP ${route.target}/${route.total}`
      })
    case 'cordon':
      return perDog((k) => (k === 'r3' ? 'watching' : robots[k].route?.state === 'finished' ? 'in place' : 'to cordon'))
    case 'inspect':
      return [{ robot: 'aloha', text: robotStateOf('aloha', snap).word }]
    case 'verdict':
      return null
  }
}

function noteOf(phase: PhaseFacts, snap: MissionSnapshot): PhaseNote | null {
  if (phase.status === 'failed') return phase.detail || 'Failed'
  if (phase.status === 'stopped') return snap.run.outcome === 'estopped' ? 'E-STOP' : 'Stopped'
  if (phase.id === 'approval') {
    if (phase.status === 'done') return 'Approved'
    const denied = snap.plans.filter((p) => p.status === 'denied').length
    return denied ? `Denied ×${denied}` : null
  }
  if (phase.id === 'verdict' && phase.status === 'done' && snap.verdict) return { verdict: snap.verdict.value }
  return null
}

export function phaseTrackOf(snap: MissionSnapshot): PhaseTrackView {
  const { run } = snap
  const phases = PHASES.map((def): TrackPhase => {
    const facts = snap.phases.find((p) => p.id === def.id)
    const status = facts?.status ?? 'pending'
    const active = status === 'active'
    const sweepStart = def.id === 'sweep' ? facts?.startedAt : null
    return {
      ...def,
      status,
      time: facts ? timeOf(facts, snap) : null,
      note: facts ? noteOf(facts, snap) : null,
      turn:
        active && def.id === 'patrol' && run.awaiting === 'instruction'
          ? 'Your instruction'
          : active && def.id === 'ready' && run.blockers.length === 0
            ? 'Start mission'
            : null,
      progress: active || status === 'stopped' ? progressOf(def.id, snap) : null,
      sub: active ? subOf(def.id, snap) : null,
      finding:
        active && snap.detection && sweepStart != null
          ? { label: 'BOX FOUND', at: formatDuration(snap.detection.foundAt - sweepStart) }
          : null,
    }
  })
  const denied = snap.plans.filter((p) => p.status === 'denied').length
  return {
    phases,
    loops: denied ? [{ from: 'approval', to: 'patrol', count: denied }] : [],
    total: run.status === 'ended' && run.startedAt !== null && run.endedAt !== null ? formatDuration(run.endedAt - run.startedAt) : null,
  }
}
