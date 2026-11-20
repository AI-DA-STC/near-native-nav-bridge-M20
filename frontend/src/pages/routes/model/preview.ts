import type { PlanRoutes, PoseFact, WaypointFact } from '@/shared/api'
import { FLEET, ROBOT_KEYS } from '@/shared/config'

/* The preview's ground: one extent for every phase of a plan, so the four maps line up, in map-frame metres */

export interface Extent {
  xMin: number
  xMax: number
  yMin: number
  yMax: number
}

/** The box the demo searches for (fleet_management.py's BOX_POSE and size): centre, size and heading */
export const BOX = { x: 4.0286, y: -1.7152, length: 0.6, width: 0.38, yaw: -0.0384 }

/** The box's corners, for its outline */
export function boxCorners(): Array<[number, number]> {
  const c = Math.cos(BOX.yaw)
  const s = Math.sin(BOX.yaw)
  const l = BOX.length / 2
  const w = BOX.width / 2
  return [
    [l, w],
    [-l, w],
    [-l, -w],
    [l, -w],
  ].map(([x, y]) => [BOX.x + c * x - s * y, BOX.y + s * x + c * y])
}

/** Every waypoint, the box, and the extras (a robot's pose, waypoints being recorded), with a metre around them */
export function extentOf(routes: PlanRoutes | null, extra: ReadonlyArray<{ x: number; y: number }> = []): Extent {
  const points: Array<{ x: number; y: number }> = [...extra, ...boxCorners().map(([x, y]) => ({ x, y }))]
  for (const phase of Object.values(routes?.phases ?? {})) for (const route of Object.values(phase ?? {})) points.push(...route)
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  return { xMin: Math.min(...xs) - 1, xMax: Math.max(...xs) + 1, yMin: Math.min(...ys) - 1, yMax: Math.max(...ys) + 1 }
}

/** The tip of a heading tick, `length` metres from the waypoint along its yaw (radians) */
export function headingTip(w: WaypointFact, length = 0.55): [number, number] {
  return [w.x + Math.cos(w.yaw) * length, w.y + Math.sin(w.yaw) * length]
}

/** A pose's yaw comes in degrees */
export function poseWaypoint(pose: PoseFact): WaypointFact {
  return { x: pose.x, y: pose.y, yaw: (pose.yaw * Math.PI) / 180 }
}

/** A robot's colour: the demo's identity for 741, 665, 738 */
export function robotColor(id: string): string {
  const key = ROBOT_KEYS.find((k) => FLEET[k].kind === 'dog' && FLEET[k].id === id)
  return key ? FLEET[key].color : 'var(--text-muted)'
}
