import type { PlanSummary, RoutePhase, RvizWhich, SetupSnapshot } from '@/shared/api'
import { FLEET, RVIZ_MARKER_COLORS, isRobotKey, type RobotKey } from '@/shared/config'

/* The mission plan's phases as demo/record_waypoints.sh records them, for the robots added in Setup, and what the Routes
 * screen says about a plan */

export const PHASES: readonly RoutePhase[] = ['patrol', 'formation', 'sweep', 'cordon', 'aloha']

/** The phases on the dogs' shared map; the ALOHA's route is on its own */
export const DOG_PHASES: readonly RoutePhase[] = ['patrol', 'formation', 'sweep', 'cordon']

export interface PhaseInfo {
  title: string
  /** In the plans' list */
  short: string
  letter: string
  /** fleet_management.py's mode, as record_waypoints.sh runs it */
  mode: string
  /** What to record, as the script and the README's table say it */
  needs: string
  /** Waypoints each robot needs */
  min: number
  /** single-waypoint: exactly one per robot, so nothing to add to */
  single: boolean
}

export const PHASE_INFO: Readonly<Record<RoutePhase, PhaseInfo>> = {
  patrol: {
    title: 'Patrol',
    short: 'Patrol',
    letter: 'P',
    mode: 'multi-waypoint-patrol',
    needs: 'Its perimeter: each corner in order, 3 or more, not the first one again',
    min: 3,
    single: false,
  },
  formation: {
    title: 'Formation',
    short: 'Formation',
    letter: 'F',
    mode: 'single-waypoint',
    needs: 'Its slot in the horizontal line: R1 slot 1, R2 slot 2, R3 slot 3',
    min: 1,
    single: true,
  },
  sweep: {
    title: 'Sweep',
    short: 'Sweep',
    letter: 'S',
    mode: 'multi-waypoint',
    needs: 'Its zone’s sweep (R1 zone 1, R2 zone 2, R3 zone 3), waypoints in order; R3 ends next to the box',
    min: 1,
    single: false,
  },
  cordon: {
    title: 'Cordon',
    short: 'Cordon',
    letter: 'C',
    mode: 'single-waypoint',
    needs: 'R1, R2: their cordon points around the box; R3: where it watches the box from',
    min: 1,
    single: true,
  },
  aloha: {
    title: 'ALOHA to the box',
    short: 'ALOHA',
    letter: 'A',
    mode: 'multi-waypoint',
    needs: 'Its route to the box, waypoints in order; it docks onto the last one, next to the box',
    min: 1,
    single: false,
  },
}

/** A robot and phase to record */
export interface Choice {
  phase: RoutePhase
  robot: string
}

/** The RViz a phase is recorded in: the dogs' on their shared map, the ALOHA's on its own */
export function rvizOf(phase: RoutePhase): RvizWhich {
  return phase === 'aloha' ? 'aloha' : 'dogs'
}

/** A robot in a sentence: the ALOHA by name (aloha.json and RViz's labels call it aloha), a dog by its ID */
export function robotName(id: string): string {
  return id === 'aloha' ? 'the ALOHA' : id
}

/** The robots added, in the lobby's order: the dogs, then the ALOHA. Each is a column of the session's grid. */
export function lobbyColumns(snapshot: SetupSnapshot): Array<{ id: string; key: RobotKey | null }> {
  const robots = [...snapshot.robots.filter((r) => r.kind === 'm20'), ...snapshot.robots.filter((r) => r.kind === 'aloha')]
  return robots.map((r) => {
    if (r.kind === 'aloha') return { id: r.id, key: 'aloha' }
    const key = (['r1', 'r2', 'r3'] as const).find((k) => FLEET[k].id === r.id)
    return { id: r.id, key: key && isRobotKey(key) ? key : null }
  })
}

/** The colour fleet_management.py draws a robot in while `recorded` is recorded into a phase whose file has `order`: its
 * place among the file's robots, then the recorded one if it is not in it yet (the same order run_demo.sh's --load takes) */
export function rvizColor(robot: string, order: readonly string[], recorded: string | null): { name: string; css: string } {
  const ids = recorded && !order.includes(recorded) ? [...order, recorded] : [...order]
  const i = Math.max(0, ids.indexOf(robot))
  const { name, rgb } = RVIZ_MARKER_COLORS[i % RVIZ_MARKER_COLORS.length]
  return { name, css: `rgb(${rgb.map((c) => Math.round(c * 255)).join(' ')})` }
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
  return plan.recorded
    .map((r) => `${r.phase === 'aloha' ? 'the ALOHA’s route' : `${PHASE_INFO[r.phase].short.toLowerCase()} · ${r.robot}`}${r.append ? ` (+${r.waypoints})` : ''}`)
    .join(', ')
}

/** Why a robot cannot be recorded now, or null: it has to be added, with its relay (the ALOHA: its bridge) running */
export function recordBlocked(snapshot: SetupSnapshot, robotId: string): string | null {
  const robot = snapshot.robots.find((r) => r.id === robotId)
  if (!robot) return `${robotId} is not added: add it on Setup`
  if (robot.presence !== 'online') return `${robotId} does not answer`
  const what = robot.kind === 'aloha' ? 'bridge' : 'relay'
  if (robot.relay.state !== 'running' && robot.relay.state !== 'kept') return `${robotId}’s ${what} is not running: set it up first`
  return null
}

/** Whether Save can work: fleet_management.py saves a patrol of 3 or more, a single waypoint, or anything else non-empty */
export function canSave(phase: RoutePhase, recorded: number, before: number, append: boolean): boolean {
  const info = PHASE_INFO[phase]
  if (recorded === 0) return false
  if (info.single) return recorded === 1
  return (append ? before + recorded : recorded) >= info.min
}
