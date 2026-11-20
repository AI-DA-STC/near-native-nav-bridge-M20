import type { PlanRoutes, PlanSummary, RecordingFacts, RoutePhase } from '@/shared/api'
import { Panel } from '@/shared/ui/Panel'
import { RobotTag } from '@/shared/ui/RobotTag'
import { PHASES, PHASE_INFO, planWhen } from '../model/plans'
import { extentOf, poseWaypoint } from '../model/preview'
import { PhaseMap, type LiveRoute } from './PhaseMap'
import './PlanPreview.css'

export interface PlanPreviewProps {
  plan: PlanSummary | null
  routes: PlanRoutes | null
  error: string | null
  /** A recording going on: its phase fills the preview, with the robot's live waypoints and pose */
  recording: RecordingFacts | null
}

/** The selected plan's routes, one small map per phase, on one extent so they line up; a recording's phase large */
export function PlanPreview({ plan, routes, error, recording }: PlanPreviewProps) {
  const live: LiveRoute | null =
    recording && (recording.state === 'starting' || recording.state === 'recording')
      ? { robot: recording.robot, waypoints: recording.waypoints, append: recording.append, pose: recording.pose }
      : null
  const extra = live ? [...live.waypoints, ...(live.pose ? [poseWaypoint(live.pose)] : [])] : []
  const extent = extentOf(routes, extra)
  const phases: RoutePhase[] = live && recording ? [recording.phase] : [...PHASES]
  return (
    <Panel
      className="cc-preview"
      title={plan ? `Preview · ${planWhen(plan.id)}` : 'Preview'}
      meta={
        <span className="cc-preview__legend">
          {(['r1', 'r2', 'r3'] as const).map((key) => (
            <RobotTag key={key} robot={key} size="sm" />
          ))}
          <span className="cc-preview__box">box</span>
        </span>
      }
    >
      {!plan ? (
        <p className="cc-preview__empty">No plan in demo/waypoints yet: record one.</p>
      ) : error ? (
        <p className="cc-preview__empty">The preview could not load: {error}</p>
      ) : (
        <div className={live ? 'cc-preview__one' : 'cc-preview__grid'}>
          {phases.map((phase) => (
            <PhaseMap
              key={phase}
              title={`${PHASE_INFO[phase].title}${live ? ` · recording ${live.robot}` : ''}`}
              routes={routes?.phases[phase] ?? null}
              extent={extent}
              closed={phase === 'patrol'}
              live={live && recording?.phase === phase ? live : null}
              problem={routes ? plan.phases[phase].problem : null}
              large={Boolean(live)}
            />
          ))}
        </div>
      )}
      <p className="cc-preview__foot">
        Map frame, metres, a grid line every metre. The ring is each robot’s first waypoint; the tick, its heading.
        {live?.pose ? ` ${live.robot} is at x ${live.pose.x.toFixed(2)}, y ${live.pose.y.toFixed(2)}, heading ${Math.round(live.pose.yaw)}°.` : ''}
      </p>
    </Panel>
  )
}
