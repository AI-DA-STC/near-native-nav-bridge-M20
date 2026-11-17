import type { Box2, Pt, SiteMap } from '@/shared/api'
import type { RobotKey } from '@/shared/config'

/* What the map draws: the site, the active phase's routes and marks, the robots and the finding (map frame, metres;
 * headings in degrees, counter-clockwise from +x) */

export type MapRouteKind = 'patrol' | 'formation' | 'sweep' | 'cordon' | 'aloha' | 'return' | 'preview'

export interface MapRoute {
  robot: RobotKey
  kind: MapRouteKind
  points: Pt[]
  /** Where a sweep starts: the robot's slot */
  from?: Pt
  /** Waypoints reached */
  reached?: number
  /** The current target, 1-based */
  current?: number | null
  closed?: boolean
}

export interface MapRobot {
  robot: RobotKey
  x: number
  y: number
  yaw: number
  trail: Pt[]
  label: string
  stale: boolean
}

export interface MapSlot {
  n: number
  robot: RobotKey
  x: number
  y: number
  yaw: number
  filled: boolean
}

export interface MapPoint {
  robot: RobotKey
  x: number
  y: number
}

/** The box, to scale, with a halo for its position's uncertainty: it tightens as R3 gets closer */
export interface MapBox {
  x: number
  y: number
  w: number
  h: number
  yaw?: number
  halo: number
  label: string
  state: 'found' | 'refined'
}

export interface MapDock {
  x: number
  y: number
  yaw: number
  docked: boolean
}

export type MapWall = SiteMap['walls'][number]

export interface MapZone {
  id: string
  label: string
  points: Pt[]
  active: boolean
}

export type MapLayerKey = 'grid' | 'walls' | 'zones' | 'routes' | 'labels' | 'sight'
export type MapLayers = Partial<Record<MapLayerKey, boolean>>

export type LegendKind = 'robot' | 'aloha' | 'sweep' | 'patrol' | 'waypoint' | 'target' | 'slot' | 'cordon' | 'box' | 'sight' | 'dock'

export interface LegendItem {
  kind: LegendKind
  label: string
  color?: RobotKey
}

export interface MapScene {
  extent: Box2
  /** A box to fit instead of the whole extent: zone 3 during the inspection */
  focus: Box2 | null
  walls: MapWall[]
  free: Pt[][]
  occupancy: SiteMap['occupancy']
  zones: MapZone[]
  routes: MapRoute[]
  slots: MapSlot[]
  cordon: MapPoint[]
  watch: MapPoint | null
  robots: MapRobot[]
  box: MapBox | null
  /** A dotted line from the robot watching the box */
  sight: { from: RobotKey } | null
  dock: MapDock | null
  /** Only what the scene draws */
  legend: LegendItem[]
}
