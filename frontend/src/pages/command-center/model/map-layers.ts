import type { Box2, MissionSnapshot, PhaseId, Pt, SiteMap } from '@/shared/api'
import { FLEET, ROBOT_KEYS } from '@/shared/config'
import { formatPercent } from '@/shared/lib'
import type { LegendItem, MapDock, MapPoint, MapRoute, MapScene, MapSlot } from '../ui/mission-map/map-data'

const DOGS = ['r1', 'r2', 'r3'] as const
const ORDER: readonly PhaseId[] = ['ready', 'patrol', 'formation', 'approval', 'sweep', 'cordon', 'inspect', 'verdict', 'return']

/** The phase whose routes the map draws: the one under way, else the last one that ran */
function shownPhase(snap: MissionSnapshot): PhaseId {
  const active = snap.phases.find((p) => p.status === 'active')
  if (active) return active.id
  const ran = ORDER.filter((id) => ['done', 'failed', 'stopped'].includes(snap.phases.find((p) => p.id === id)?.status ?? ''))
  return ran.length ? ran[ran.length - 1] : 'ready'
}

function inside([x, y]: Pt, polygon: Pt[]): boolean {
  let hit = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

function bounds(points: Pt[], pad: number): Box2 {
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  return { xMin: Math.min(...xs) - pad, xMax: Math.max(...xs) + pad, yMin: Math.min(...ys) - pad, yMax: Math.max(...ys) + pad }
}

/** What the map draws for the mission now, after the brief's map section: each phase shows its own routes and marks */
export function mapSceneOf(snap: MissionSnapshot, site: SiteMap): MapScene {
  const shown = shownPhase(snap)
  const { robots, detection } = snap
  const slotOf = (k: (typeof DOGS)[number]) => site.routes.slots.find((s) => s.robot === k)!
  const inSlot = (k: (typeof DOGS)[number]) => {
    const r = robots[k].route
    return r !== null && (r.kind === 'formation' || r.kind === 'return') && r.state === 'finished'
  }
  const at = (k: (typeof DOGS)[number]): Pt | null => (robots[k].pose ? [robots[k].pose!.x, robots[k].pose!.y] : null)
  const toPoint = (k: (typeof DOGS)[number], to: Pt): Pt[] => {
    const from = at(k)
    return from ? [from, to] : []
  }
  const routes: MapRoute[] = []
  let slots: MapSlot[] = []
  let cordon: MapPoint[] = []
  let watch: MapPoint | null = null
  let dock: MapDock | null = null
  const siteDock = (): MapDock => ({ ...site.routes.aloha.dock, docked: robots.aloha.docking.state === 'docked' })

  switch (shown) {
    case 'ready':
    case 'patrol':
      for (const k of DOGS) {
        const loop = site.routes.patrol[k]
        if (loop) routes.push({ robot: k, kind: 'patrol', points: loop, closed: true })
      }
      slots = site.routes.slots.map((s) => ({ ...s, filled: false }))
      break
    case 'formation':
    case 'approval':
      for (const k of DOGS) {
        const slot = slotOf(k)
        if (!inSlot(k)) routes.push({ robot: k, kind: 'formation', points: toPoint(k, [slot.x, slot.y]) })
        // the plan waiting for approval, as a dashed preview of the sweep it would start
        if (snap.run.awaiting === 'approval' && site.routes.sweep[k]) routes.push({ robot: k, kind: 'preview', points: [[slot.x, slot.y], ...site.routes.sweep[k]!] })
      }
      slots = site.routes.slots.map((s) => ({ ...s, filled: inSlot(s.robot as (typeof DOGS)[number]) }))
      break
    case 'sweep':
      for (const k of DOGS) {
        const slot = slotOf(k)
        const r = robots[k].route
        const sweeping = r?.kind === 'sweep'
        routes.push({
          robot: k,
          kind: 'sweep',
          from: [slot.x, slot.y],
          points: site.routes.sweep[k] ?? [],
          reached: sweeping ? (r.state === 'finished' ? r.total : r.reached) : 0,
          current: sweeping && r.state === 'driving' ? r.target : null,
        })
      }
      break
    case 'cordon':
    case 'inspect':
    case 'verdict':
      cordon = site.routes.cordon
      watch = site.routes.watch
      for (const k of DOGS) {
        const r = robots[k].route
        if (r?.kind === 'cordon' && r.state === 'driving' && r.goal) routes.push({ robot: k, kind: 'formation', points: toPoint(k, [r.goal.x, r.goal.y]) })
      }
      if (shown !== 'cordon') {
        routes.push({ robot: 'aloha', kind: 'aloha', points: site.routes.aloha.path })
        dock = siteDock()
      }
      break
    case 'return':
      for (const k of DOGS) {
        const slot = slotOf(k)
        if (!inSlot(k)) routes.push({ robot: k, kind: 'return', points: toPoint(k, [slot.x, slot.y]) })
      }
      slots = site.routes.slots.map((s) => ({ ...s, filled: inSlot(s.robot as (typeof DOGS)[number]) }))
      dock = siteDock()
      break
  }

  const boxAt: Pt | null = detection ? [detection.x, detection.y] : null
  const boxZone = boxAt ? site.zones.find((z) => inside(boxAt, z.points)) : undefined
  const watching = ['sweep', 'cordon', 'inspect', 'verdict'].includes(shown)
  const sight = detection && watching && robots[detection.by].pose ? { from: detection.by } : null
  const focus =
    (shown === 'inspect' || shown === 'verdict') && boxZone
      ? bounds([...boxZone.points, ...site.routes.cordon.map((c): Pt => [c.x, c.y]), [site.routes.watch.x, site.routes.watch.y], ...site.routes.aloha.path], 1.2)
      : null

  const legend: LegendItem[] = []
  if (routes.some((r) => r.kind === 'patrol')) legend.push({ kind: 'patrol', label: 'patrol loop' })
  if (routes.some((r) => r.kind === 'preview')) legend.push({ kind: 'patrol', label: 'plan preview' })
  if (routes.some((r) => r.kind === 'sweep')) legend.push({ kind: 'sweep', label: 'route' }, { kind: 'waypoint', label: 'waypoint' }, { kind: 'target', label: 'current target' })
  if (slots.length) legend.push({ kind: 'slot', label: 'formation slot' })
  if (cordon.length) legend.push({ kind: 'cordon', label: 'cordon point' })
  if (detection) legend.push({ kind: 'box', label: 'box · confidence halo' })
  if (sight) legend.push({ kind: 'sight', label: 'sight line' })
  if (dock) legend.push({ kind: 'dock', label: 'dock pose' })

  return {
    extent: site.extent,
    focus,
    walls: site.walls,
    free: site.free,
    occupancy: site.occupancy,
    zones: site.zones.map((z) => ({
      ...z,
      active: shown === 'sweep' || (['cordon', 'inspect', 'verdict'].includes(shown) && z.id === boxZone?.id),
    })),
    routes: routes.filter((r) => r.points.length > 1 || r.kind === 'sweep'),
    slots,
    cordon,
    watch,
    robots: ROBOT_KEYS.flatMap((k) => {
      const { pose, trail } = robots[k]
      if (!pose) return []
      return [{ robot: k, x: pose.x, y: pose.y, yaw: pose.yawDeg, trail, label: FLEET[k].label, stale: snap.serverTime - pose.at > snap.limits.poseStaleMs }]
    }),
    box: detection
      ? {
          x: detection.x,
          y: detection.y,
          w: detection.size.w,
          h: detection.size.h,
          halo: detection.uncertaintyM,
          label: `BOX ${formatPercent(detection.confidence)}`,
          state: detection.refinements ? 'refined' : 'found',
        }
      : null,
    sight,
    dock,
    legend,
  }
}
