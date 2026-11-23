import type { Box2, Pt, SiteMap } from '../src/shared/api/mission-stream.ts'
import type { PlanRoutes, WaypointFact } from '../src/shared/api/setup-protocol.ts'
import type { RobotKey } from '../src/shared/config/fleet.ts'

/* The Command center's map, from the plan in use and the dogs' SLAM map: each phase's routes by role, the formation
 * slots, the cordon points and where R3 watches the box, the box where fleet_management.py has it, and the grid image
 * map_grid.py writes. The ALOHA's route is left out while its map is not the dogs'. */

/** fleet_management.py's BOX_POSE and size: centre, yaw in degrees, metres */
export const BOX = { x: 4.0286, y: -1.7152, yaw: (-0.0384 * 180) / Math.PI, w: 0.6, h: 0.38 }

/** Where the grid image lies in the map frame */
export interface GridImage {
  url: string
  x: number
  y: number
  w: number
  h: number
}

const pt = (w: WaypointFact): Pt => [w.x, w.y]

function bounds(points: readonly Pt[], pad: number): Box2 {
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  return { xMin: Math.min(...xs) - pad, xMax: Math.max(...xs) + pad, yMin: Math.min(...ys) - pad, yMax: Math.max(...ys) + pad }
}

/** `roleOf` maps a robot ID to its role (741 → r1); `watcher` is R3, who watches the box */
export function siteMapOf(plan: PlanRoutes | null, roleOf: (id: string) => RobotKey | null, grid: GridImage | null): SiteMap {
  const phase = (name: keyof PlanRoutes['phases']) =>
    Object.entries(plan?.phases[name] ?? {}).flatMap(([id, route]) => {
      const role = roleOf(id)
      return role && role !== 'aloha' ? [[role, route] as const] : []
    })
  const patrol = Object.fromEntries(phase('patrol').map(([role, route]) => [role, route.map(pt)]))
  const sweep = Object.fromEntries(phase('sweep').map(([role, route]) => [role, route.map(pt)]))
  const slots = phase('formation').flatMap(([role, route]) =>
    route[0] ? [{ n: role === 'r1' ? 1 : role === 'r2' ? 2 : 3, robot: role, x: route[0].x, y: route[0].y, yaw: (route[0].yaw * 180) / Math.PI }] : [],
  )
  const cordonAll = phase('cordon').flatMap(([role, route]) => (route[0] ? [{ robot: role, x: route[0].x, y: route[0].y }] : []))
  // R3 watches the box: from its own cordon point when the plan has one, else from the end of its sweep
  const r3Sweep = sweep.r3?.at(-1)
  const watch = cordonAll.find((c) => c.robot === 'r3') ?? (r3Sweep ? { robot: 'r3' as const, x: r3Sweep[0], y: r3Sweep[1] } : null)
  const cordon = cordonAll.filter((c) => c.robot !== 'r3')
  const points: Pt[] = [
    ...Object.values(patrol).flat(),
    ...Object.values(sweep).flat(),
    ...slots.map((s): Pt => [s.x, s.y]),
    ...cordonAll.map((c): Pt => [c.x, c.y]),
    [BOX.x, BOX.y],
  ]
  if (grid) points.push([grid.x, grid.y], [grid.x + grid.w, grid.y + grid.h])
  return {
    extent: bounds(points, grid ? 0.5 : 1.5),
    occupancy: grid,
    free: [],
    walls: [],
    zones: [],
    box: BOX,
    routes: { patrol, slots, sweep, cordon, watch, aloha: null },
  }
}
