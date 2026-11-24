import type { Box2, MissionSnapshot, PhaseId, Pt, SiteMap } from '@/shared/api'
import { FLEET, ROBOT_KEYS } from '@/shared/config'
import { formatPercent } from '@/shared/lib'
import type { LegendItem, MapDock, MapPoint, MapRoute, MapScene, MapSlot } from '../ui/mission-map/map-data'

const ALL_DOGS = ['r1', 'r2', 'r3'] as const
type Dog = (typeof ALL_DOGS)[number]
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
  // Only the dogs in this mission; the ALOHA only while its map is the dogs'
  const DOGS = ALL_DOGS.filter((k) => robots[k].inMission)
  const alohaShown = robots.aloha.inMission && robots.aloha.sameMap && site.routes.aloha !== null
  const slotOf = (k: Dog) => site.routes.slots.find((s) => s.robot === k)
  const inSlot = (k: Dog) => {
    const r = robots[k].route
    return r !== null && (r.kind === 'formation' || r.kind === 'return') && r.state === 'finished'
  }
  const at = (k: Dog): Pt | null => (robots[k].pose ? [robots[k].pose!.x, robots[k].pose!.y] : null)
  const toPoint = (k: Dog, to: Pt): Pt[] => {
    const from = at(k)
    return from ? [from, to] : []
  }
  const routes: MapRoute[] = []
  let slots: MapSlot[] = []
  let cordon: MapPoint[] = []
  let watch: MapPoint | null = null
  let dock: MapDock | null = null
  const siteDock = (): MapDock | null => (alohaShown && site.routes.aloha ? { ...site.routes.aloha.dock, docked: robots.aloha.docking.state === 'docked' } : null)

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
        if (!slot) continue
        if (!inSlot(k)) routes.push({ robot: k, kind: 'formation', points: toPoint(k, [slot.x, slot.y]) })
        // the plan waiting for approval, as a dashed preview of the sweep it would start
        if (snap.run.awaiting === 'approval' && site.routes.sweep[k]) routes.push({ robot: k, kind: 'preview', points: [[slot.x, slot.y], ...site.routes.sweep[k]!] })
      }
      slots = site.routes.slots.map((s) => ({ ...s, filled: inSlot(s.robot as Dog) }))
      break
    case 'sweep':
      for (const k of DOGS) {
        const slot = slotOf(k)
        const r = robots[k].route
        const sweeping = r?.kind === 'sweep'
        if (!site.routes.sweep[k]) continue
        routes.push({
          robot: k,
          kind: 'sweep',
          from: slot ? [slot.x, slot.y] : (site.routes.sweep[k]![0] ?? [0, 0]),
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
      if (shown !== 'cordon' && alohaShown && site.routes.aloha) {
        routes.push({ robot: 'aloha', kind: 'aloha', points: site.routes.aloha.path })
        dock = siteDock()
      }
      break
    case 'return':
      for (const k of DOGS) {
        const slot = slotOf(k)
        if (slot && !inSlot(k)) routes.push({ robot: k, kind: 'return', points: toPoint(k, [slot.x, slot.y]) })
      }
      slots = site.routes.slots.map((s) => ({ ...s, filled: inSlot(s.robot as Dog) }))
      dock = siteDock()
      break
  }

  // Where the box is: as it was found, else where the plan knows it to be. Only the found box is drawn
  const boxAt: Pt | null = detection ? [detection.x, detection.y] : site.box ? [site.box.x, site.box.y] : null
  // demo/find_box.py reports the box where demo/box.json has it (confidence 1.00): its footprint and heading, no halo
  const knownBox = detection && detection.confidence >= 1 && detection.refinements === 0 && site.box ? { ...site.box, x: detection.x, y: detection.y } : null
  const boxZone = boxAt ? site.zones.find((z) => inside(boxAt, z.points)) : undefined
  const watching = ['sweep', 'cordon', 'inspect', 'verdict'].includes(shown)
  const sight = detection && watching && robots[detection.by].pose ? { from: detection.by } : null
  const watchAt: Pt[] = site.routes.watch ? [[site.routes.watch.x, site.routes.watch.y]] : []
  const focus =
    (shown === 'inspect' || shown === 'verdict') && boxAt
      ? bounds(
          [
            boxAt,
            ...(boxZone?.points ?? []),
            ...site.routes.cordon.map((c): Pt => [c.x, c.y]),
            ...watchAt,
            ...(alohaShown && site.routes.aloha ? site.routes.aloha.path : []),
          ],
          1.8,
        )
      : null

  const legend: LegendItem[] = []
  if (routes.some((r) => r.kind === 'patrol')) legend.push({ kind: 'patrol', label: 'patrol loop' })
  if (routes.some((r) => r.kind === 'preview')) legend.push({ kind: 'patrol', label: 'plan preview' })
  if (routes.some((r) => r.kind === 'sweep')) legend.push({ kind: 'sweep', label: 'route' }, { kind: 'waypoint', label: 'waypoint' }, { kind: 'target', label: 'current target' })
  if (slots.length) legend.push({ kind: 'slot', label: 'formation slot' })
  if (cordon.length) legend.push({ kind: 'cordon', label: 'cordon point' })
  if (detection) legend.push({ kind: 'box', label: knownBox ? 'box' : 'box · confidence halo' })
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
      const { pose, trail, inMission } = robots[k]
      if (!pose || !inMission || (k === 'aloha' && !alohaShown)) return []
      return [{ robot: k, x: pose.x, y: pose.y, yaw: pose.yawDeg, trail, label: FLEET[k].label, stale: snap.serverTime - pose.at > snap.limits.poseStaleMs }]
    }),
    // The box appears once it is found (R3 reached it), not before
    box: detection
      ? knownBox
        ? { x: knownBox.x, y: knownBox.y, yaw: knownBox.yaw, w: knownBox.w, h: knownBox.h, halo: 0, label: 'BOX', state: 'found' }
        : {
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

/** The ALOHA's own map, apart from the dogs': its grid, its route to the box with the waypoint it drives to, the pose
 * it docks from, and where it is (its /amcl_pose, on that map). The two maps are not aligned, so nothing of the dogs'
 * is drawn on it. */
export function alohaSceneOf(snap: MissionSnapshot, site: SiteMap): MapScene {
  const aloha = snap.robots.aloha
  const route = site.routes.aloha
  const driving = aloha.route?.kind === 'aloha' ? aloha.route : null
  const routes: MapRoute[] = route
    ? [{ robot: 'aloha', kind: 'aloha', points: route.path, reached: driving?.reached ?? 0, current: driving?.state === 'driving' ? driving.target : null }]
    : []
  const dock: MapDock | null = route ? { ...route.dock, docked: aloha.docking.state === 'docked' } : null
  const legend: LegendItem[] = []
  if (route) legend.push({ kind: 'aloha', label: 'route to the box' }, { kind: 'waypoint', label: 'waypoint' })
  if (dock) legend.push({ kind: 'dock', label: 'dock pose at the box' })
  return {
    extent: site.extent,
    focus: null,
    walls: site.walls,
    free: site.free,
    occupancy: site.occupancy,
    zones: [],
    routes,
    slots: [],
    cordon: [],
    watch: null,
    robots:
      aloha.pose && aloha.inMission
        ? [{ robot: 'aloha', x: aloha.pose.x, y: aloha.pose.y, yaw: aloha.pose.yawDeg, trail: aloha.trail, label: FLEET.aloha.label, stale: snap.serverTime - aloha.pose.at > snap.limits.poseStaleMs }]
        : [],
    box: null,
    sight: null,
    dock,
    legend,
  }
}
