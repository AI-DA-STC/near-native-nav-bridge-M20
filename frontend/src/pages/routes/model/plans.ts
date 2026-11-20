import type { PlanSummary, RobotSetupFacts, RoutePhase, SetupSnapshot } from '@/shared/api'
import { FLEET, type RobotKey } from '@/shared/config'

/* The mission plan's phases as demo/record_waypoints.sh records them, and what the Routes screen says about a plan */

export const PHASES: readonly RoutePhase[] = ['patrol', 'formation', 'sweep', 'cordon']

export interface PhaseInfo {
  title: string
  letter: string
  /** fleet_management.py's mode, as record_waypoints.sh runs it */
  mode: string
  /** What to record, as the script and the README's table say it */
  needs: string
  roles: readonly RobotKey[]
  /** Waypoints each robot needs */
  min: number
  /** single-waypoint: exactly one per robot, so nothing to add to */
  single: boolean
}

export const PHASE_INFO: Readonly<Record<RoutePhase, PhaseInfo>> = {
  patrol: {
    title: 'Patrol',
    letter: 'P',
    mode: 'multi-waypoint-patrol',
    needs: 'Its perimeter: each corner in order, 3 or more, not the first one again',
    roles: ['r1', 'r2', 'r3'],
    min: 3,
    single: false,
  },
  formation: {
    title: 'Formation',
    letter: 'F',
    mode: 'single-waypoint',
    needs: 'Its slot in the horizontal line: R1 slot 1, R2 slot 2, R3 slot 3',
    roles: ['r1', 'r2', 'r3'],
    min: 1,
    single: true,
  },
  sweep: {
    title: 'Sweep',
    letter: 'S',
    mode: 'multi-waypoint',
    needs: 'Its zone’s sweep (R1 zone 1, R2 zone 2, R3 zone 3), waypoints in order; R3 ends next to the box',
    roles: ['r1', 'r2', 'r3'],
    min: 1,
    single: false,
  },
  cordon: {
    title: 'Cordon',
    letter: 'C',
    mode: 'single-waypoint',
    needs: 'Its cordon point around zone 3',
    roles: ['r1', 'r2'],
    min: 1,
    single: true,
  },
}

/** The robot playing a role: R1 is 741 */
export function roleId(role: RobotKey): string {
  return FLEET[role].id
}

/** "2026-11-20_15-02-10" → "20 Nov 2026 · 15:02:10": the name is the operator's local time */
export function planWhen(id: string, withYear = true): string {
  const [date, time] = id.split('_')
  const month = new Date(`${date}T00:00:00`).toLocaleString('en-GB', { month: 'short' })
  const day = `${Number(date.slice(8, 10))} ${month}${withYear ? ` ${date.slice(0, 4)}` : ''}`
  return `${day} · ${time.replaceAll('-', ':')}`
}

/** The plan to show first: the one asked for, else the latest */
export function selectedPlan(plans: readonly PlanSummary[], picked: string | null): PlanSummary | null {
  return plans.find((p) => p.id === picked) ?? plans[0] ?? null
}

/** What a plan re-recorded over its base, in a line: "sweep · 738 (+2)" */
export function recordedLine(plan: PlanSummary): string | null {
  if (!plan.recorded.length) return null
  return plan.recorded.map((r) => `${PHASE_INFO[r.phase].title.toLowerCase()} · ${r.robot}${r.append ? ` (+${r.waypoints})` : ''}`).join(', ')
}

/** Why a robot cannot be recorded now, or null: it has to be in the lobby with its relay running */
export function recordBlocked(snapshot: SetupSnapshot, robotId: string): string | null {
  const robot: RobotSetupFacts | undefined = snapshot.robots.find((r) => r.id === robotId)
  if (!robot) return `${robotId} is not in the lobby: add it on Setup`
  if (robot.presence !== 'online') return `${robotId} does not answer`
  if (robot.relay.state !== 'running' && robot.relay.state !== 'kept') return `${robotId}’s relay is not running: set it up first`
  return null
}

/** Whether Save can work: fleet_management.py saves a patrol of 3 or more, a single waypoint, or anything else non-empty */
export function canSave(phase: RoutePhase, recorded: number, before: number, append: boolean): boolean {
  const info = PHASE_INFO[phase]
  if (recorded === 0) return false
  if (info.single) return recorded === 1
  return (append ? before + recorded : recorded) >= info.min
}
