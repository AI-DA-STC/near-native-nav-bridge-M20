import type { PlanRoutes, PlanSummary, RouteSessionFacts, SetupSnapshot, WaypointFact } from '@/shared/api'
import { cssVars, cx } from '@/shared/lib'
import { Panel } from '@/shared/ui/Panel'
import { PHASE_INFO, robotName, rvizColor, rvizOf, type Choice } from '../model/plans'
import './PhaseWaypoints.css'

export interface PhaseWaypointsProps {
  snapshot: SetupSnapshot
  session: RouteSessionFacts
  /** The session's plan */
  plan: PlanSummary | null
  routes: PlanRoutes | null
  /** The robot and phase picked, when none is being recorded */
  chosen: Choice | null
}

interface Row {
  robot: string
  color: { name: string; css: string }
  waypoints: Array<WaypointFact & { n: number; fresh: boolean }>
  /** Being recorded now */
  live: boolean
  /** Waypoints the recording will replace on save */
  replaces: number
}

/** The phase being recorded as RViz draws it, without the map: each robot in its RViz colour, its saved waypoints
 * dimmed and the new ones as fleet_management.py records them (by the GUI's button or an arrow drawn in RViz), numbered
 * as RViz labels them */
export function PhaseWaypoints({ snapshot, session, plan, routes, chosen }: PhaseWaypointsProps) {
  const recording = session.recording
  const active = recording && (recording.state === 'starting' || recording.state === 'recording') ? recording : null
  const focus: Choice | null = active ? { phase: active.phase, robot: active.robot } : chosen
  if (!focus) {
    return (
      <Panel className="cc-phasewps" title="Waypoints">
        <p className="cc-phasewps__empty">
          Pick a robot and a phase on the left. Recording opens RViz on the map with that phase’s routes, each robot in its own colour; every waypoint
          recorded shows here too.
        </p>
      </Panel>
    )
  }
  const { phase } = focus
  const which = rvizOf(phase)
  const order = plan?.phases[phase].order ?? []
  const saved = routes?.phases[phase] ?? {}
  const robots = [...order, ...snapshot.participants[phase].filter((id) => !order.includes(id))]
  const rows: Row[] = robots.map((robot) => {
    const kept = saved[robot] ?? []
    const live = active?.robot === robot
    const before = live && !active.append ? [] : kept
    const fresh = live ? active.waypoints : []
    return {
      robot,
      color: rvizColor(robot, order, focus.robot),
      waypoints: [...before.map((w, i) => ({ ...w, n: i + 1, fresh: false })), ...fresh.map((w, i) => ({ ...w, n: before.length + i + 1, fresh: true }))],
      live,
      replaces: live && !active.append ? kept.length : 0,
    }
  })
  const pose = active?.pose ?? null
  return (
    <Panel
      className="cc-phasewps"
      title={`${PHASE_INFO[phase].title} · waypoints`}
      meta={<span className="cc-phasewps__meta">{active ? `as ${which === 'dogs' ? 'RViz · dogs' : 'RViz · ALOHA'} draws them` : 'saved in this plan'}</span>}
      scroll
    >
      <p className="cc-phasewps__lead">
        {active
          ? `${robotName(active.robot).replace(/^t/, 'T')} in ${rows.find((r) => r.live)?.color.name ?? 'its colour'}${rows.length > 1 ? ', the other routes dimmed' : ''}, as in RViz on the map. A waypoint recorded there or here shows in both.`
          : `Start recording to see them in RViz on the map${which === 'aloha' ? ' (the ALOHA’s own map)' : ''}, each robot in the colour shown here.`}
      </p>
      <ul className="cc-phasewps__robots">
        {rows.map((row) => (
          <li key={row.robot} className={cx('cc-phasewps__robot', row.live && 'is-live')} style={cssVars({ '--rc': row.color.css })}>
            <p className="cc-phasewps__head">
              <span className="cc-phasewps__id">{row.robot}</span>
              <span className="cc-phasewps__color">{row.color.name} in RViz</span>
              {row.live ? <span className="cc-phasewps__now">recording</span> : null}
            </p>
            {row.waypoints.length ? (
              <ol className="cc-phasewps__list" aria-label={`${row.robot}’s waypoints`}>
                {row.waypoints.map((w) => (
                  <li key={w.n} className={cx(w.fresh && 'is-fresh')}>
                    <span className="cc-phasewps__n">
                      {row.robot}·{w.n}
                    </span>
                    x {w.x.toFixed(2)} · y {w.y.toFixed(2)} · {Math.round((w.yaw * 180) / Math.PI)}°
                  </li>
                ))}
              </ol>
            ) : (
              <p className="cc-phasewps__none">{row.live ? 'None recorded yet' : routes ? 'No waypoint in this plan' : 'Loading the plan…'}</p>
            )}
            {row.replaces ? (
              <p className="cc-phasewps__note">
                Replaces its {row.replaces} saved waypoint{row.replaces === 1 ? '' : 's'} when you save
              </p>
            ) : null}
            {row.live ? (
              <p className="cc-phasewps__pose">
                {pose
                  ? `Now at x ${pose.x.toFixed(2)} · y ${pose.y.toFixed(2)} · ${Math.round(pose.yaw)}°`
                  : `No pose yet from ${phase === 'aloha' ? '/amcl_pose' : `/ODOM_relayed_${row.robot}`}`}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </Panel>
  )
}
