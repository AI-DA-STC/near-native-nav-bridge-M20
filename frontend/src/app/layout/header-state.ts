import type { AlohaFacts, ConnectionStatus, MissionSnapshot, Notice } from '@/shared/api'
import { formatClock, type Tone } from '@/shared/lib'
import type { MissionState } from './StateChip'

/* What the header shows, mapped from the snapshot's facts: the header applies no rules of its own, so it can never
 * disagree with the page (a stale pose is stale by the backend's own limit) */

export interface HeaderPill {
  id: string
  label: string
  value: string
  tone: Tone | null
  pulse?: boolean
  mono?: boolean
  title?: string
}

export interface HeaderState {
  state: MissionState
  stateDetail: string | null
  /** The brandmark turns while the mission runs, waits for the operator, or stops */
  running: boolean
  clock: string
  clockLabel: 'ELAPSED' | 'TOTAL'
  clockRunning: boolean
  pills: HeaderPill[]
  attention: Notice[]
}

const DOGS = ['r1', 'r2', 'r3'] as const

function missionState(snap: MissionSnapshot): { state: MissionState; detail: string | null } {
  const { run, estop } = snap
  if (estop && (run.outcome === 'estopped' || run.status === 'idle')) {
    const confirmed = estop.results.filter((r) => r.state === 'confirmed').length
    return { state: 'estopped', detail: `${confirmed}/${estop.results.length} confirmed` }
  }
  switch (run.status) {
    case 'idle':
      return run.blockers.length ? { state: 'not-ready', detail: run.blockers[0].text } : { state: 'ready', detail: null }
    case 'stopping':
      return { state: 'stopping', detail: 'Robots finishing their waypoints' }
    case 'ended':
      if (run.outcome === 'failed') return { state: 'failed', detail: run.reason }
      if (run.outcome === 'stopped') return { state: 'ended', detail: 'Stopped' }
      return { state: 'ended', detail: snap.verdict ? snap.verdict.value.toUpperCase() : null }
    case 'running': {
      const plan = snap.plans[snap.plans.length - 1]
      if (run.awaiting === 'instruction') return { state: 'waiting', detail: 'Your instruction' }
      if (run.awaiting === 'approval') return { state: 'waiting', detail: `Plan ${plan?.id ?? ''}: approve or deny` }
      if (run.awaiting === 'verdict') return { state: 'waiting', detail: 'Verdict: ANOMALY or CLEAR' }
      return { state: 'running', detail: null }
    }
  }
}

function alohaPill(aloha: AlohaFacts, idle: boolean): Pick<HeaderPill, 'value' | 'tone'> {
  if (aloha.bridge === 'disconnected') return { value: 'not connected', tone: 'fault' }
  if (aloha.docking.state === 'failed') return { value: 'not docked', tone: 'fault' }
  if (aloha.nav === 'waiting') return { value: 'waiting for move_base', tone: 'warn' }
  if (aloha.arms.pose > 0) return { value: `arms ${aloha.arms.pose}/${aloha.arms.of}`, tone: 'ok' }
  if (aloha.docking.state === 'active') return { value: `docking ${aloha.docking.attempt}/${aloha.docking.of}`, tone: 'ok' }
  if (aloha.docking.state === 'docked') return { value: 'docked', tone: 'ok' }
  if (aloha.route?.state === 'driving') return { value: 'driving', tone: 'ok' }
  return { value: idle ? 'ready' : 'standby', tone: 'ok' }
}

export function headerStateOf(snap: MissionSnapshot, connection: ConnectionStatus): HeaderState {
  const { run, robots, serverTime, limits } = snap
  const { state, detail } = missionState(snap)
  // The dogs in this mission: added in Setup and named in the confirmed plan
  const dogs = DOGS.filter((k) => robots[k].inMission)
  const connected = dogs.filter((k) => robots[k].bridge === 'connected').length
  const placed = dogs.filter((k) => {
    const pose = robots[k].pose
    return pose !== null && serverTime - pose.at <= limits.poseStaleMs
  }).length
  const elapsed = run.startedAt === null ? 0 : (run.endedAt ?? serverTime) - run.startedAt
  const attention = [...run.blockers, ...snap.warnings].filter((n, i, all) => all.findIndex((m) => m.id === n.id) === i)
  if (connection === 'closed') {
    attention.unshift({ id: 'stream', tone: 'fault', robot: null, text: 'No snapshots from the mission backend', fix: 'is it running?', since: serverTime })
  }
  return {
    state,
    stateDetail: detail,
    running: state === 'running' || state === 'waiting' || state === 'stopping',
    clock: formatClock(elapsed),
    clockLabel: run.status === 'ended' ? 'TOTAL' : 'ELAPSED',
    clockRunning: run.status === 'running' || run.status === 'stopping',
    pills: [
      { id: 'fleet', label: 'Fleet', value: `${connected}/${dogs.length}`, tone: connected === dogs.length ? 'ok' : 'fault', title: 'Robot dogs in this mission whose nav bridge listens' },
      { id: 'positions', label: 'Positions', value: `${placed}/${dogs.length}`, tone: placed === dogs.length ? 'ok' : 'warn', title: 'Robot dogs in this mission with a fresh position on the map' },
      ...(robots.aloha.inMission ? [{ id: 'aloha', label: 'ALOHA', ...alohaPill(robots.aloha, run.status === 'idle') }] : []),
      { id: 'domains', label: 'Domains', value: `${robots.r1.domain} / ${robots.aloha.domain}`, tone: null, mono: true, title: 'ROS domains: the dogs, then the ALOHA' },
    ],
    attention,
  }
}
