import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import type { Pt } from '@/shared/api'
import { robotOf, type RobotKey } from '@/shared/config'
import { cssVars, cx, formatNumber } from '@/shared/lib'
import { IDENTITY, followViewport, projectionOf, scaleStep, zoomAt, type Size, type Viewport } from '../../lib/map-projection'
import type { MapLayers, MapScene } from './map-data'
import './LiveMap.css'

const DEG = Math.PI / 180

/** The stage's size: measured before the first paint, then followed as the window changes */
function useSize(ref: RefObject<HTMLDivElement | null>): Size {
  const [size, setSize] = useState<Size>({ w: 640, h: 420 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const measure = (width: number, height: number) => {
      const next = { w: Math.max(80, Math.round(width)), h: Math.max(80, Math.round(height)) }
      setSize((prev) => (prev.w === next.w && prev.h === next.h ? prev : next))
    }
    const rect = el.getBoundingClientRect()
    if (rect.width && rect.height) measure(rect.width, rect.height)
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect.width, entry.contentRect.height))
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return size
}

/** x and y under the pointer: its own state, so moving the pointer does not redraw the map */
function CursorReadout({ register }: { register: (show: ((pt: Pt | null) => void) | null) => void }) {
  const [cursor, setCursor] = useState<Pt | null>(null)
  useEffect(() => {
    register(setCursor)
    return () => register(null)
  }, [register])
  if (!cursor) return null
  return <div className="cc-map__cursor cc-mono cc-num">{`x ${formatNumber(cursor[0])}  y ${formatNumber(cursor[1])}`}</div>
}

export interface LiveMapProps extends Partial<Omit<MapScene, 'legend'>> {
  extent: MapScene['extent']
  selected?: RobotKey | null
  follow?: RobotKey | null
  /** 3d is a tilted placeholder for now */
  view?: '2d' | '3d'
  trails?: boolean
  layers?: MapLayers
  showScale?: boolean
  showAxes?: boolean
  showCursor?: boolean
  onRobotClick?: (robot: RobotKey) => void
  /** Change it to reset pan and zoom */
  resetKey?: unknown
  height?: number | string
  className?: string
  /** The toolbar and the legend, floating over the map */
  children?: ReactNode
}

/** The robots' own top-down map in metres, never a geographic one: the grid, the zones, the active phase's routes, the
 * robots with their trails, the box and its halo. Wheel zooms, drag pans. */
export function LiveMap({
  extent,
  focus,
  walls = [],
  free = [],
  occupancy,
  zones = [],
  routes = [],
  slots = [],
  cordon = [],
  watch,
  robots = [],
  box,
  sight,
  dock,
  selected,
  follow,
  view = '2d',
  trails = true,
  layers = {},
  showScale = true,
  showAxes = true,
  showCursor = true,
  onRobotClick,
  resetKey,
  height,
  className,
  children,
}: LiveMapProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const size = useSize(stageRef)
  const [vp, setVp] = useState<Viewport>(IDENTITY)
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const showCursorAt = useRef<((pt: Pt | null) => void) | null>(null)
  const registerCursor = useCallback((show: ((pt: Pt | null) => void) | null) => {
    showCursorAt.current = show
  }, [])
  const [resetSeen, setResetSeen] = useState(resetKey)
  if (resetSeen !== resetKey) {
    setResetSeen(resetKey)
    setVp(IDENTITY)
  }
  // pan, zoom and the cursor's position assume a flat map
  const flat = view === '2d'

  const on: Required<MapLayers> = { grid: true, walls: true, zones: true, routes: true, labels: true, sight: true, ...layers }
  const pad = { x: 30, top: children ? 58 : 30, bottom: children ? 52 : 30 }
  const fit = focus ?? extent
  const followed = follow ? robots.find((r) => r.robot === follow) : undefined
  const viewport = followed ? followViewport(size, fit, pad, vp, followed.x, followed.y) : vp
  const proj = projectionOf(size, fit, pad, viewport)
  const P = proj.toScreen
  const s = proj.scale
  const pts = (points: Pt[]) => points.map((p) => P(p[0], p[1]).map((v) => v.toFixed(1)).join(',')).join(' ')
  const at = (x: number, y: number) => {
    const [px, py] = P(x, y)
    return `translate(${px.toFixed(1)} ${py.toFixed(1)})`
  }
  const rc = (key: RobotKey) => robotOf(key).color

  // the wheel listener must be able to preventDefault, which React's synthetic onWheel cannot
  useEffect(() => {
    const el = svgRef.current
    if (!el || !flat) return undefined
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
      setVp((v) => zoomAt(v, size, e.clientX - rect.left, e.clientY - rect.top, factor))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [size, flat])

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || !flat) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, tx: vp.tx, ty: vp.ty }
  }
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!flat) return
    const rect = e.currentTarget.getBoundingClientRect()
    if (showCursor) showCursorAt.current?.(proj.toMap(e.clientX - rect.left, e.clientY - rect.top))
    const d = drag.current
    if (d && !followed) setVp((v) => ({ ...v, tx: d.tx + e.clientX - d.x, ty: d.ty + e.clientY - d.y }))
  }
  const endDrag = (e: ReactPointerEvent<SVGSVGElement>) => {
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  const grid = []
  if (on.grid) {
    for (let x = Math.ceil(extent.xMin); x <= Math.floor(extent.xMax); x++) {
      const [x1, y1] = P(x, extent.yMin)
      const [x2, y2] = P(x, extent.yMax)
      grid.push(<line key={`gx${x}`} x1={x1} y1={y1} x2={x2} y2={y2} className={x % 5 === 0 ? 'cc-map__grid is-major' : 'cc-map__grid'} />)
    }
    for (let y = Math.ceil(extent.yMin); y <= Math.floor(extent.yMax); y++) {
      const [x1, y1] = P(extent.xMin, y)
      const [x2, y2] = P(extent.xMax, y)
      grid.push(<line key={`gy${y}`} x1={x1} y1={y1} x2={x2} y2={y2} className={y % 5 === 0 ? 'cc-map__grid is-major' : 'cc-map__grid'} />)
    }
  }
  const scaleM = scaleStep(s)
  const sightFrom = box && sight ? robots.find((r) => r.robot === sight.from) : undefined

  return (
    <div className={cx('cc-map', view === '3d' && 'is-3d', className)} style={height ? { height } : undefined}>
      <div className="cc-map__stage" ref={stageRef}>
        <svg
          ref={svgRef}
          className="cc-map__svg"
          width={size.w}
          height={size.h}
          viewBox={`0 0 ${size.w} ${size.h}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={() => showCursorAt.current?.(null)}
          role="img"
          aria-label="Live map, map frame in metres"
        >
          <rect className="cc-map__ground" x="0" y="0" width={size.w} height={size.h} />
          {occupancy ? (
            <image
              href={occupancy.url}
              x={P(occupancy.x, occupancy.y + occupancy.h)[0]}
              y={P(occupancy.x, occupancy.y + occupancy.h)[1]}
              width={occupancy.w * s}
              height={occupancy.h * s}
              preserveAspectRatio="none"
              className="cc-map__occ"
            />
          ) : null}
          {on.walls ? free.map((f, i) => <polygon key={`f${i}`} className="cc-map__free" points={pts(f)} />) : null}
          <g>{grid}</g>
          {on.walls
            ? walls.map((w, i) => {
                if ('rect' in w) {
                  const [x, y] = P(w.rect[0], w.rect[1] + w.rect[3])
                  return <rect key={`w${i}`} className="cc-map__block" x={x} y={y} width={w.rect[2] * s} height={w.rect[3] * s} />
                }
                return (
                  <polyline
                    key={`w${i}`}
                    className="cc-map__wall"
                    points={pts(w.closed ? [...w.points, w.points[0]] : w.points)}
                    style={{ strokeWidth: Math.max(2.5, 0.12 * s) }}
                  />
                )
              })
            : null}
          {on.zones
            ? zones.map((z) => {
                const [tx, ty] = P(Math.max(...z.points.map((p) => p[0])), Math.max(...z.points.map((p) => p[1])))
                return (
                  <g key={z.id} className={cx('cc-map__zone', z.active && 'is-active')}>
                    <polygon points={pts(z.points)} />
                    <text x={tx - 6} y={ty + 14} textAnchor="end">
                      {z.label}
                    </text>
                  </g>
                )
              })
            : null}
          {on.routes
            ? routes.map((route, i) => {
                const all = route.closed ? [...route.points, route.points[0]] : route.points
                if (route.kind !== 'sweep' && route.kind !== 'cordon') {
                  return <polyline key={`rt${i}`} className={`cc-map__route is-${route.kind}`} points={pts(all)} style={{ stroke: rc(route.robot) }} />
                }
                const reached = route.reached ?? 0
                const legs = route.from ? [route.from, ...route.points] : route.points
                const offset = route.from ? 1 : 0
                const done = legs.slice(0, reached + offset)
                const ahead = legs.slice(Math.max(0, reached + offset - 1))
                return (
                  <g key={`rt${i}`} className={`cc-map__sweep is-${route.kind}`} style={cssVars({ '--rc': rc(route.robot) })}>
                    {done.length > 1 ? <polyline className="cc-map__path is-done" points={pts(done)} /> : null}
                    {ahead.length > 1 ? <polyline className="cc-map__path" points={pts(ahead)} /> : null}
                    {route.points.map((p, j) => {
                      const n = j + 1
                      const state = n <= reached ? 'reached' : n === route.current ? 'current' : 'todo'
                      return (
                        <g key={j} className={`cc-map__wp is-${state}`} transform={at(p[0], p[1])}>
                          {state === 'current' ? <circle className="cc-map__wp-pulse" r="9" /> : null}
                          <circle className="cc-map__wp-dot" r="8" />
                          <text y="3.5">{n}</text>
                        </g>
                      )
                    })}
                  </g>
                )
              })
            : null}
          {slots.map((slot) => (
            <g key={`slot${slot.n}`} className={cx('cc-map__slot', slot.filled && 'is-filled')} transform={at(slot.x, slot.y)} style={cssVars({ '--rc': rc(slot.robot) })}>
              <rect x="-8" y="-8" width="16" height="16" rx="3" />
              <line x1="8" y1="0" x2="13" y2="0" transform={`rotate(${-slot.yaw})`} />
              <text y="3.5">{slot.n}</text>
            </g>
          ))}
          {cordon.map((c) => (
            <g key={`cordon-${c.robot}`} className="cc-map__cordon" transform={at(c.x, c.y)} style={cssVars({ '--rc': rc(c.robot) })}>
              <path d="M0 -8L8 0L0 8L-8 0Z" />
            </g>
          ))}
          {watch ? (
            <g className="cc-map__watch" transform={at(watch.x, watch.y)} style={cssVars({ '--rc': rc(watch.robot) })}>
              <circle r="7" />
              <circle r="2.4" className="cc-map__watch-dot" />
            </g>
          ) : null}
          {dock ? (
            <g className={cx('cc-map__dock', dock.docked && 'is-docked')} transform={`${at(dock.x, dock.y)} rotate(${-dock.yaw})`}>
              <rect x={-0.45 * s} y={-0.3 * s} width={0.9 * s} height={0.6 * s} rx="3" />
              <path d={`M${0.45 * s} 0h7M${0.45 * s + 3} -3l4 3-4 3`} />
              {on.labels ? (
                <text x="0" y={-0.3 * s - 5} transform={`rotate(${dock.yaw})`}>
                  dock
                </text>
              ) : null}
            </g>
          ) : null}
          {box
            ? (() => {
                const [qx, qy] = P(box.x, box.y)
                const halo = Math.max(10, box.halo * s)
                const bw = Math.max(10, box.w * s)
                const bh = Math.max(7, box.h * s)
                const sp = sightFrom ? P(sightFrom.x, sightFrom.y) : null
                return (
                  <g className={cx('cc-map__box', `is-${box.state}`)}>
                    {on.sight && sp && sightFrom ? <line className="cc-map__sight" x1={sp[0]} y1={sp[1]} x2={qx} y2={qy} style={{ stroke: rc(sightFrom.robot) }} /> : null}
                    <circle className="cc-map__halo" cx={qx} cy={qy} r={halo} />
                    <g transform={`translate(${qx.toFixed(1)} ${qy.toFixed(1)}) rotate(${-(box.yaw ?? 0)})`}>
                      <rect className="cc-map__boxrect" x={-bw / 2} y={-bh / 2} width={bw} height={bh} rx="1.5" />
                      {[
                        [-1, -1],
                        [1, -1],
                        [1, 1],
                        [-1, 1],
                      ].map(([dx, dy], i) => {
                        const x = (dx * bw) / 2 + dx * 5
                        const y = (dy * bh) / 2 + dy * 5
                        return <path key={i} className="cc-map__bracket" d={`M${x} ${y - dy * 5}V${y}H${x - dx * 5}`} />
                      })}
                    </g>
                    {on.labels ? (
                      <g transform={`translate(${(qx + halo * 0.72 + 4).toFixed(1)} ${(qy - halo * 0.72 - 4).toFixed(1)})`}>
                        <rect className="cc-map__boxchip" x="0" y="-12" width={box.label.length * 6.9 + 12} height="17" rx="4" />
                        <text className="cc-map__boxtext" x="6" y="0">
                          {box.label}
                        </text>
                      </g>
                    ) : null}
                  </g>
                )
              })()
            : null}
          {trails
            ? robots.map((r) =>
                r.trail.length < 2 ? null : (
                  <g key={`tr-${r.robot}`} className="cc-map__trail">
                    {r.trail.slice(1).map((p, i) => {
                      const [x1, y1] = P(r.trail[i][0], r.trail[i][1])
                      const [x2, y2] = P(p[0], p[1])
                      return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} style={{ stroke: rc(r.robot), opacity: (0.08 + (0.55 * (i + 1)) / r.trail.length).toFixed(2) }} />
                    })}
                  </g>
                ),
              )
            : null}
          {robots.map((r) => {
            const robot = robotOf(r.robot)
            const isSelected = selected === r.robot
            const labelWidth = r.label.length * 6.9 + 10
            // the label sits behind the robot, so the chevron's point stays clear
            const behind = Math.cos(r.yaw * DEG) >= 0
            return (
              <g
                key={`rb-${r.robot}`}
                className={cx('cc-map__robot', isSelected && 'is-selected', r.stale && 'is-stale', onRobotClick && 'is-clickable')}
                transform={at(r.x, r.y)}
                style={cssVars({ '--rc': robot.color })}
                onClick={onRobotClick ? () => onRobotClick(r.robot) : undefined}
              >
                {isSelected ? <circle className="cc-map__sel" r="17" /> : null}
                <g transform={`rotate(${-r.yaw})`}>
                  {robot.kind === 'aloha' ? (
                    <g>
                      <rect className="cc-map__body" x="-10" y="-7.5" width="17.5" height="15" rx="3" />
                      <circle className="cc-map__arm" cx="7.6" cy="-4.6" r="2.7" />
                      <circle className="cc-map__arm" cx="7.6" cy="4.6" r="2.7" />
                    </g>
                  ) : (
                    <path className="cc-map__body" d="M11.5 0L-8 9L-3.6 0L-8 -9Z" />
                  )}
                </g>
                {on.labels ? (
                  <g transform={`translate(${behind ? -16 - labelWidth : 16} -15)`}>
                    <rect className="cc-map__chip" x="0" y="-11" width={labelWidth} height="16" rx="4" />
                    <text className="cc-map__label" x="5" y="1">
                      {r.label}
                    </text>
                  </g>
                ) : null}
              </g>
            )
          })}
          {showAxes
            ? (() => {
                const [ox, oy] = P(0, 0)
                const [axx, axy] = P(1, 0)
                const [ayx, ayy] = P(0, 1)
                return (
                  <g className="cc-map__axes">
                    <line x1={ox} y1={oy} x2={axx} y2={axy} />
                    <line x1={ox} y1={oy} x2={ayx} y2={ayy} />
                    <path d={`M${axx} ${axy}l-6 -3.5v7z`} />
                    <path d={`M${ayx} ${ayy}l-3.5 6h7z`} />
                    <text x={axx + 5} y={axy + 4}>
                      x
                    </text>
                    <text x={ayx - 3} y={ayy - 6}>
                      y
                    </text>
                  </g>
                )
              })()
            : null}
        </svg>
      </div>
      {view === '3d' ? <div className="cc-map__note">3D view · placeholder</div> : null}
      {showScale ? (
        <div className="cc-map__scale" aria-label={`Scale bar ${scaleM} m`}>
          <span className="cc-map__scalebar" style={{ width: scaleM * s }} />
          <span>{scaleM} m</span>
        </div>
      ) : null}
      {showCursor && flat ? <CursorReadout register={registerCursor} /> : null}
      {children ? <div className="cc-map__overlay">{children}</div> : null}
    </div>
  )
}
