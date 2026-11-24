import type { MissionSnapshot } from '@/shared/api'
import type { RobotKey } from '@/shared/config'
import type { Tone } from '@/shared/lib'

type DogKey = Exclude<RobotKey, 'aloha'>

export interface RobotState {
  /** The state word: PATROLLING · LAP 3, DOCKING 2/3, STALE 4 s … */
  word: string
  /** ok while it runs fine; warn, fault, or neutral (standby, stopped) */
  tone: Tone
  /** What it is doing, in a line */
  task: string | null
}

/** Each dog's slot in the line and its sweep zone, as plan SR2 assigns them */
const SLOT: Record<DogKey, number> = { r1: 1, r2: 2, r3: 3 }

function dogState(key: DogKey, snap: MissionSnapshot): RobotState {
  const route = snap.robots[key].route
  if (!route) return { word: 'STANDBY', tone: 'neutral', task: snap.run.status === 'idle' ? 'Waiting for Start' : null }
  const n = SLOT[key]
  const driving = route.state === 'driving'
  switch (route.kind) {
    case 'patrol':
      return { word: `PATROLLING · LAP ${route.lap}`, tone: 'ok', task: `Patrol loop → WP ${route.target}/${route.total}` }
    case 'formation':
      return driving ? { word: 'TO SLOT', tone: 'ok', task: `To slot ${n}` } : { word: 'IN SLOT', tone: 'ok', task: `In slot ${n}` }
    case 'sweep': {
      const found = key === 'r3' && snap.detection ? ' · box found' : ''
      return driving
        ? { word: 'SWEEPING', tone: 'ok', task: `Sweep zone ${n} → WP ${route.target}/${route.total}${found}` }
        : { word: 'DONE', tone: 'ok', task: `Sweep zone ${n} done${found}` }
    }
    case 'cordon':
      return key === 'r3'
        ? { word: 'WATCHING ITEM', tone: 'ok', task: driving ? 'To its watch point by the box' : 'Watching the item' }
        : { word: 'CORDON', tone: 'ok', task: driving ? 'Cordon zone 3 → its cordon point' : 'Holding the cordon of zone 3' }
    case 'return':
      return driving ? { word: 'RETURNING', tone: 'ok', task: `Return to slot ${n}` } : { word: 'IN SLOT', tone: 'ok', task: `Back in slot ${n}` }
    case 'aloha':
      return { word: 'STANDBY', tone: 'neutral', task: null }
  }
}

function alohaState(snap: MissionSnapshot): RobotState {
  const { route, nav, docking, arms } = snap.robots.aloha
  if (nav === 'waiting') return { word: 'STANDBY', tone: 'warn', task: 'Waiting for move_base: is its bridge running?' }
  if (arms.state === 'done') return { word: 'DONE', tone: 'ok', task: 'Arms done · photos taken' }
  if (arms.pose > 0) {
    return {
      word: `ARMS ${arms.pose}/${arms.of}${arms.state === 'holding' ? ' · PHOTOS' : ''}`,
      tone: 'ok',
      task: arms.state === 'holding' ? 'Holding while the wrist cameras photograph the box' : `Arms to pose ${arms.pose} of ${arms.of}`,
    }
  }
  if (docking.state === 'docked') return { word: 'DOCKED', tone: 'ok', task: 'Docked at the box' }
  if (docking.state === 'active') {
    return { word: `DOCKING ${docking.attempt}/${docking.of}`, tone: 'ok', task: `Dock at the box · correction ${docking.attempt} of ${docking.of}` }
  }
  if (route?.state === 'driving') return { word: 'DRIVING', tone: 'ok', task: 'Drive to the box' }
  return { word: 'STANDBY', tone: 'neutral', task: snap.run.status === 'idle' ? 'Ready: navigation and arms answering' : 'Waits for the cordon' }
}

/** A robot's state word and tone, by priority: NOT CONNECTED › NO POSITION › STALE n s › FAILED › STOPPED › what it is
 * doing in the phase */
export function robotStateOf(key: RobotKey, snap: MissionSnapshot): RobotState {
  const facts = snap.robots[key]
  if (!facts.inMission) return { word: 'NOT IN MISSION', tone: 'neutral', task: 'Not added in Setup, or not in the confirmed plan' }
  if (facts.bridge === 'disconnected') return { word: 'NOT CONNECTED', tone: 'fault', task: key === 'aloha' ? 'Is its bridge running, and move_base?' : 'Is its nav bridge running?' }
  // after E-STOP each robot shows its own answer: a robot that has not confirmed is never shown as stopped
  const estop = snap.estop?.results.find((r) => r.robot === key)
  if (estop?.state === 'unconfirmed') return { word: 'E-STOP NOT CONFIRMED', tone: 'fault', task: `No confirmation: ${estop.reason ?? 'no answer'}` }
  if (estop?.state === 'pending') return { word: 'E-STOP SENT', tone: 'warn', task: 'Waiting for its answer' }
  if (estop?.state === 'confirmed') return { word: 'STOPPED', tone: 'neutral', task: `Stopped by E-STOP · confirmed ${estop.latencyMs} ms` }
  if (!facts.pose) return { word: 'NO POSITION', tone: 'warn', task: 'Connected; no pose on the map yet' }
  const doing = key === 'aloha' ? alohaState(snap) : dogState(key, snap)
  const age = snap.serverTime - facts.pose.at
  if (age > snap.limits.poseStaleMs) return { word: `STALE ${Math.round(age / 1000)} s`, tone: 'warn', task: doing.task }
  const aloha = key === 'aloha' ? snap.robots.aloha : null
  if (facts.route?.state === 'failed' || aloha?.docking.state === 'failed') {
    return { word: 'FAILED', tone: 'fault', task: aloha?.docking.state === 'failed' ? 'Not docked after 90 s' : doing.task }
  }
  if (facts.route?.state === 'stopped' || aloha?.arms.state === 'stopped') {
    const why = snap.run.outcome === 'estopped' ? 'Stopped by E-STOP' : 'Finished its waypoint, then stopped'
    return { word: 'STOPPED', tone: 'neutral', task: aloha && aloha.arms.pose ? `Arms frozen at pose ${aloha.arms.pose}/${aloha.arms.of}` : why }
  }
  return doing
}
