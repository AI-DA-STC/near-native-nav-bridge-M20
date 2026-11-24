import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Box2, Pt, SiteMap } from '../src/shared/api/mission-stream.ts'
import type { PlanRoutes, WaypointFact } from '../src/shared/api/setup-protocol.ts'
import type { RobotKey } from '../src/shared/config/fleet.ts'

/* The Command center's map, from the plan in use and the dogs' SLAM map: each phase's routes by role, the formation
 * slots, the cordon points and where R3 watches the box, the box (demo/box.json), and the grid image map_grid.py writes.
 * The ALOHA's route is left out while its map is not the dogs'. */

export type SiteBox = NonNullable<SiteMap['box']>

let cached: { file: string; mtime: number; box: SiteBox | null } | null = null

/** demo/box.json, as fleet_management.py and demo/find_box.py read it (yaw in radians): centre, yaw in degrees, metres.
 * Null when it is missing or cannot be read. Read again once the file changes. */
export function readBox(packageRoot: string): SiteBox | null {
  const file = join(packageRoot, 'demo', 'box.json')
  try {
    const mtime = statSync(file).mtimeMs
    if (cached?.file === file && cached.mtime === mtime) return cached.box
    const b = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    const [x, y, yaw, w, h] = [b.x, b.y, b.yaw ?? 0, b.length, b.width].map(Number)
    const box = [x, y, yaw, w, h].every(Number.isFinite) ? { x, y, yaw: (yaw * 180) / Math.PI, w, h } : null
    cached = { file, mtime, box }
    return box
  } catch {
    return null
  }
}

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

/** The ALOHA's own map, apart from the dogs': its SLAM grid (/map through aloha/bridge.sh), its route to the box
 * (aloha.json, on that map) and the pose it docks from, its last waypoint. Nothing of the dogs' is on it: the two maps
 * are not aligned. */
export function alohaSiteOf(plan: PlanRoutes | null, grid: GridImage | null): SiteMap {
  const route = plan?.phases.aloha?.aloha ?? []
  const path = route.map(pt)
  const last = route.at(-1)
  const points: Pt[] = [...path]
  if (grid) points.push([grid.x, grid.y], [grid.x + grid.w, grid.y + grid.h])
  return {
    extent: points.length ? bounds(points, grid ? 0.5 : 1.5) : { xMin: -5, xMax: 5, yMin: -5, yMax: 5 },
    occupancy: grid,
    free: [],
    walls: [],
    zones: [],
    box: null,
    routes: {
      patrol: {},
      slots: [],
      sweep: {},
      cordon: [],
      watch: null,
      aloha: last ? { start: path[0], path, dock: { x: last.x, y: last.y, yaw: (last.yaw * 180) / Math.PI } } : null,
    },
  }
}

/** `roleOf` maps a robot ID to its role (741 → r1); R3 watches the box */
export function siteMapOf(plan: PlanRoutes | null, roleOf: (id: string) => RobotKey | null, grid: GridImage | null, box: SiteBox | null): SiteMap {
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
    ...(box ? [[box.x, box.y] as Pt] : []),
  ]
  if (grid) points.push([grid.x, grid.y], [grid.x + grid.w, grid.y + grid.h])
  return {
    extent: bounds(points, grid ? 0.5 : 1.5),
    occupancy: grid,
    free: [],
    walls: [],
    zones: [],
    box,
    routes: { patrol, slots, sweep, cordon, watch, aloha: null },
  }
}
