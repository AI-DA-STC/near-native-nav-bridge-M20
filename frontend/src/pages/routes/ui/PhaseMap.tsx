import type { WaypointFact } from '@/shared/api'
import { cx } from '@/shared/lib'
import { boxCorners, headingTip, robotColor, type Extent } from '../model/preview'
import './PhaseMap.css'

export interface PhaseMapProps {
  title: string
  /** robot ID → waypoints, as saved; null: not recorded */
  routes: Record<string, WaypointFact[]> | null
  extent: Extent
  /** A patrol loops back to its first waypoint */
  closed: boolean
  /** The box, on the dogs' map (the ALOHA's is another map) */
  box: boolean
  problem?: string | null
}

const pt = (w: { x: number; y: number }) => `${w.x},${-w.y}`

/** A sketch of one phase of a plan, without the map (RViz has it): each robot's waypoints in order, the first ringed,
 * each with its heading, the box outlined; north is up, a grid line every metre */
export function PhaseMap({ title, routes, extent, closed, box, problem }: PhaseMapProps) {
  const { xMin, xMax, yMin, yMax } = extent
  const width = xMax - xMin
  const height = yMax - yMin
  const columns = Array.from({ length: Math.floor(xMax) - Math.ceil(xMin) + 1 }, (_, i) => Math.ceil(xMin) + i)
  const rows = Array.from({ length: Math.floor(yMax) - Math.ceil(yMin) + 1 }, (_, i) => Math.ceil(yMin) + i)
  const drawn = Object.entries(routes ?? {})
  const counts = Object.entries(routes ?? {})
    .map(([robot, route]) => `${robot} ${route.length}`)
    .join(', ')
  return (
    <figure className="cc-phasemap">
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
        {box ? <polygon className="cc-phasemap__box" points={boxCorners().map(([x, y]) => pt({ x, y })).join(' ')} /> : null}
        {drawn.map(([robot, route]) => (
          <Route key={robot} robot={robot} route={route} closed={closed} />
        ))}
      </svg>
    </figure>
  )
}

function Route({ robot, route, closed }: { robot: string; route: WaypointFact[]; closed: boolean }) {
  if (!route.length) return null
  const color = robotColor(robot)
  const path = closed && route.length >= 3 ? [...route, route[0]] : route
  return (
    <g className="cc-phasemap__route" style={{ color }}>
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
