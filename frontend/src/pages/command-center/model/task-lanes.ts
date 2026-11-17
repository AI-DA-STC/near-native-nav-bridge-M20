import type { MissionSnapshot, PhaseId } from '@/shared/api'
import { ROBOT_KEYS, type RobotKey } from '@/shared/config'
import { PHASES } from './phase-track'
import { routeProgress } from './route-progress'

export type LaneCellState = 'done' | 'active' | 'pending' | 'idle' | 'wait' | 'failed' | 'stopped' | 'skipped'

export interface LaneCell {
  /** What the robot does in that phase, as the plan says it */
  text: string
  state: LaneCellState
  /** 0–1 for the active cell */
  progress: number | null
}

export interface Lane {
  robot: RobotKey
  cells: Record<PhaseId, LaneCell>
}

/** Each robot's task in each phase, from plan SR2's steps */
const TASKS: Record<RobotKey, Record<PhaseId, string>> = {
  r1: { ready: 'Bring-up', patrol: 'Patrol loop', formation: 'To slot 1', approval: 'In slot', sweep: 'Sweep zone 1', cordon: 'Cordon zone 3', inspect: 'Hold cordon', verdict: 'Hold', return: 'Return to slot 1' },
  r2: { ready: 'Bring-up', patrol: 'Patrol loop', formation: 'To slot 2', approval: 'In slot', sweep: 'Sweep zone 2', cordon: 'Cordon zone 3', inspect: 'Hold cordon', verdict: 'Hold', return: 'Return to slot 2' },
  r3: { ready: 'Bring-up', patrol: 'Patrol loop', formation: 'To slot 3', approval: 'In slot', sweep: 'Sweep zone 3 · search', cordon: 'Watch item', inspect: 'Watch item', verdict: 'Hold', return: 'Return to slot 3' },
  aloha: { ready: 'Ready', patrol: 'Standby', formation: 'Standby', approval: 'Standby', sweep: 'Standby', cordon: 'Waits for cordon', inspect: 'Drive · dock · lid · scan', verdict: 'Hold', return: 'Dock' },
}

/** The phases the ALOHA has nothing to do in */
const ALOHA_IDLE: ReadonlySet<PhaseId> = new Set(['patrol', 'formation', 'approval', 'sweep'])

export function taskLanesOf(snap: MissionSnapshot): Lane[] {
  const status = (id: PhaseId) => snap.phases.find((p) => p.id === id)?.status ?? 'pending'
  const reached = (id: PhaseId) => status(id) !== 'pending'
  return ROBOT_KEYS.map((robot) => {
    const facts = snap.robots[robot]
    const cells = Object.fromEntries(
      PHASES.map(({ id }) => {
        let state: LaneCellState
        const phase = status(id)
        if (robot === 'aloha' && ALOHA_IDLE.has(id) && phase !== 'skipped') {
          state = reached(id) ? 'idle' : 'pending'
        } else if (robot === 'aloha' && id === 'cordon' && phase !== 'done') {
          // it waits on the dogs from the sweep on: the cordon must be in place before it drives in
          state = phase === 'active' || reached('sweep') ? 'wait' : 'pending'
        } else if (phase === 'failed') {
          state = robot === 'aloha' ? 'failed' : 'done'
        } else if (id === 'ready' && phase === 'active' && facts.bridge === 'disconnected') {
          state = 'failed'
        } else {
          state = phase
        }
        const progress =
          state !== 'active'
            ? null
            : robot === 'aloha'
              ? id === 'inspect'
                ? (routeProgress(facts.route) + snap.robots.aloha.arms.pose / snap.robots.aloha.arms.of) / 2
                : null
              : routeProgress(facts.route)
        return [id, { text: TASKS[robot][id], state, progress }]
      }),
    ) as Record<PhaseId, LaneCell>
    return { robot, cells }
  })
}
