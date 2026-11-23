import type { PlanRoutes, PlanSummary } from '@/shared/api'
import { cssVars } from '@/shared/lib'
import { Panel } from '@/shared/ui/Panel'
import { DOG_PHASES, PHASE_INFO, planWhen } from '../model/plans'
import { extentOf, robotColor } from '../model/preview'
import { PhaseMap } from './PhaseMap'
import './PlanPreview.css'

export interface PlanPreviewProps {
  plan: PlanSummary | null
  routes: PlanRoutes | null
  error: string | null
}

/** Sketches of the selected plan's routes, without the map: the dogs' four phases on one extent so they line up, and
 * the ALOHA's route on its own (its map is not theirs). RViz shows them on the map while you record. */
export function PlanPreview({ plan, routes, error }: PlanPreviewProps) {
  const dogs = extentOf(routes, DOG_PHASES, true)
  const aloha = extentOf(routes, ['aloha'], false)
  const robots = [...new Set(Object.values(routes?.phases ?? {}).flatMap((phase) => Object.keys(phase ?? {})))]
  return (
    <Panel
      className="cc-preview"
      title={plan ? `Preview · ${planWhen(plan.id)}` : 'Preview'}
      meta={
        <span className="cc-preview__legend">
          {robots.map((robot) => (
            <span key={robot} className="cc-preview__robot" style={cssVars({ '--rc': robotColor(robot) })}>
              {robot === 'aloha' ? 'ALOHA' : robot}
            </span>
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
        <div className="cc-preview__grid">
          {DOG_PHASES.map((phase) => (
            <PhaseMap
              key={phase}
              title={PHASE_INFO[phase].title}
              routes={routes?.phases[phase] ?? null}
              extent={dogs}
              closed={phase === 'patrol'}
              box
              problem={routes ? plan.phases[phase].problem : null}
            />
          ))}
          <PhaseMap
            title={PHASE_INFO.aloha.title}
            routes={routes?.phases.aloha ?? null}
            extent={aloha}
            closed={false}
            box={false}
            problem={routes ? plan.phases.aloha.problem : null}
          />
          <p className="cc-preview__foot">
            Sketches in map-frame metres, a grid line every metre, without the map: RViz shows them on it while you record. The ring is each robot’s
            first waypoint; the tick, its heading. The ALOHA’s route is on its own map, not the dogs’.
          </p>
        </div>
      )}
    </Panel>
  )
}
