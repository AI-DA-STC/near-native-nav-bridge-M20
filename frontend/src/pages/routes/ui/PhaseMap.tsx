import type { PoseFact, WaypointFact } from '@/shared/api'
import { cx } from '@/shared/lib'
import { boxCorners, headingTip, poseWaypoint, robotColor, type Extent } from '../model/preview'
import './PhaseMap.css'

/** The robot being recorded: its live waypoints and where it is now */
export interface LiveRoute {
  robot: string
  waypoints: WaypointFact[]
  /** Added after its saved waypoints, or replacing them */
  append: boolean
  pose: PoseFact | null
}

export interface PhaseMapProps {
  title: string
  /** robot ID → waypoints, as saved; null: not recorded */
  routes: Record<string, WaypointFact[]> | null
  extent: Extent
  /** A patrol loops back to its first waypoint */
  closed: boolean
  live?: LiveRoute | null
  problem?: string | null
  large?: boolean
}

const pt = (w: { x: number; y: number }) => `${w.x},${-w.y}`

/** One phase of a plan on the map frame: each robot's waypoints in order, the first ringed, each with its heading, the
 * box outlined; north is up, a grid line every metre */
export function PhaseMap({ title, routes, extent, closed, live, problem, large }: PhaseMapProps) {
  const { xMin, xMax, yMin, yMax } = extent
  const width = xMax - xMin
  const height = yMax - yMin
  const columns = Array.from({ length: Math.floor(xMax) - Math.ceil(xMin) + 1 }, (_, i) => Math.ceil(xMin) + i)
  const rows = Array.from({ length: Math.floor(yMax) - Math.ceil(yMin) + 1 }, (_, i) => Math.ceil(yMin) + i)
  const drawn = Object.entries(routes ?? {}).map(([robot, route]) => ({ robot, route, dim: live?.robot === robot && !live.append }))
  const counts = Object.entries(routes ?? {})
    .map(([robot, route]) => `${robot} ${route.length}`)
    .join(', ')
  return (
    <figure className={cx('cc-phasemap', large && 'is-large')}>
      <figcaption className="cc-phasemap__head">
        <span className="cc-phasemap__title">{title}</span>
        <span className={cx('cc-phasemap__note', problem && 'cc-tone--warn')}>{problem ?? (routes ? null : 'not recorded')}</span>
      </figcaption>
      <svg
        className="cc-phasemap__svg"
        viewBox={`${xMin} ${-yMax} ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`${title}: ${routes ? `waypoints per robot ${counts}` : 'not recorded'}`}
      >
        <g className="cc-phasemap__grid">
          {columns.map((x) => (
            <line key={`x${x}`} x1={x} x2={x} y1={-yMax} y2={-yMin} />
          ))}
          {rows.map((y) => (
            <line key={`y${y}`} x1={xMin} x2={xMax} y1={-y} y2={-y} />
          ))}
        </g>
        <polygon className="cc-phasemap__box" points={boxCorners().map(([x, y]) => pt({ x, y })).join(' ')} />
        {drawn.map(({ robot, route, dim }) => (
          <Route key={robot} robot={robot} route={route} closed={closed} dim={dim} />
        ))}
        {live ? <Route robot={live.robot} route={live.append ? [...(routes?.[live.robot] ?? []), ...live.waypoints] : live.waypoints} closed={closed} live /> : null}
        {live?.pose ? <Pose robot={live.robot} pose={poseWaypoint(live.pose)} /> : null}
      </svg>
    </figure>
  )
}

function Route({ robot, route, closed, dim, live }: { robot: string; route: WaypointFact[]; closed: boolean; dim?: boolean; live?: boolean }) {
  if (!route.length) return null
  const color = robotColor(robot)
  const path = closed && route.length >= 3 ? [...route, route[0]] : route
  return (
    <g className={cx('cc-phasemap__route', dim && 'is-dim', live && 'is-live')} style={{ color }}>
      {path.length > 1 ? <polyline points={path.map(pt).join(' ')} /> : null}
      {route.map((w, i) => {
        const [tx, ty] = headingTip(w)
        return (
          <g key={i}>
            <line className="cc-phasemap__heading" x1={w.x} y1={-w.y} x2={tx} y2={-ty} />
            <circle className="cc-phasemap__wp" cx={w.x} cy={-w.y} r={0.13} />
          </g>
        )
      })}
      <circle className="cc-phasemap__first" cx={route[0].x} cy={-route[0].y} r={0.32} />
      <text className="cc-phasemap__label" x={route[0].x + 0.42} y={-route[0].y - 0.3}>
        {robot}
      </text>
    </g>
  )
}

/** Where the robot is now, from its odometry */
function Pose({ robot, pose }: { robot: string; pose: WaypointFact }) {
  const [tx, ty] = headingTip(pose, 0.8)
  return (
    <g className="cc-phasemap__pose" style={{ color: robotColor(robot) }}>
      <circle cx={pose.x} cy={-pose.y} r={0.24} />
      <line x1={pose.x} y1={-pose.y} x2={tx} y2={-ty} />
    </g>
  )
}
