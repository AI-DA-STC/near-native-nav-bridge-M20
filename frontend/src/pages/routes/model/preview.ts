import type { PlanRoutes, RoutePhase, WaypointFact } from '@/shared/api'
import { FLEET, ROBOT_KEYS } from '@/shared/config'

/* The sketches' ground: one extent for the dogs' phases of a plan, so the four line up, and another for the ALOHA's
 * route (its own map), in map-frame metres */

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

const MIN_SPAN_M = 10

/** Every waypoint of these phases (one map's), with the box when `box`, and a metre around them */
export function extentOf(routes: PlanRoutes | null, phases: readonly RoutePhase[], box: boolean): Extent {
  const points: Array<{ x: number; y: number }> = box ? boxCorners().map(([x, y]) => ({ x, y })) : []
  for (const phase of phases) for (const route of Object.values(routes?.phases[phase] ?? {})) points.push(...route)
  if (!points.length) points.push({ x: 0, y: 0 })
  const span = (values: number[]): [number, number] => {
    const lo = Math.min(...values)
    const hi = Math.max(...values)
    // A metre around them, and 10 m across at least: a route of one waypoint is not drawn metres wide
    const half = Math.max((hi - lo) / 2 + 1, MIN_SPAN_M / 2)
    return [(lo + hi) / 2 - half, (lo + hi) / 2 + half]
  }
  const [xMin, xMax] = span(points.map((p) => p.x))
  const [yMin, yMax] = span(points.map((p) => p.y))
  return { xMin, xMax, yMin, yMax }
}

/** The tip of a heading tick, `length` metres from the waypoint along its yaw (radians) */
export function headingTip(w: WaypointFact, length = 0.55): [number, number] {
  return [w.x + Math.cos(w.yaw) * length, w.y + Math.sin(w.yaw) * length]
}

/** A robot's colour in the sketches: the demo's identity for 741, 665, 738 and the ALOHA (aloha.json's "aloha") */
export function robotColor(id: string): string {
  if (id === 'aloha') return FLEET.aloha.color
  const key = ROBOT_KEYS.find((k) => FLEET[k].kind === 'dog' && FLEET[k].id === id)
  return key ? FLEET[key].color : 'var(--text-muted)'
}
