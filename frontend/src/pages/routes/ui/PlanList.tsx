import type { PlanSummary } from '@/shared/api'
import { cx } from '@/shared/lib'
import { Badge } from '@/shared/ui/Badge'
import { StatusMark } from '@/shared/ui/StatusMark'
import { PHASES, PHASE_INFO, planWhen, recordedLine } from '../model/plans'
import './PlanList.css'

export interface PlanListProps {
  plans: readonly PlanSummary[]
  selected: string | null
  /** The plan confirmed in this run of the console */
  confirmed: string | null
  onSelect: (id: string) => void
}

/** Every plan in demo/waypoints, newest first: when it was recorded, whether each phase is complete for the robots
 * added, what it changed */
export function PlanList({ plans, selected, confirmed, onSelect }: PlanListProps) {
  if (!plans.length) return <p className="cc-plans__empty">No plans in demo/waypoints yet.</p>
  return (
    <ol className="cc-plans" aria-label="Plans">
      {plans.map((plan, i) => {
        const changed = [
          recordedLine(plan) && `Re-recorded ${recordedLine(plan)}`,
          plan.leftOut.length > 0 && `without ${plan.leftOut.join(', ')}`,
        ].filter(Boolean)
        return (
          <li key={plan.id}>
            <button type="button" className={cx('cc-plan', plan.id === selected && 'is-selected')} aria-current={plan.id === selected} onClick={() => onSelect(plan.id)}>
              <span className="cc-plan__when">{planWhen(plan.id)}</span>
              <span className="cc-plan__tags">
                {i === 0 ? (
                  <Badge size="sm" tone="neutral">
                    Latest
                  </Badge>
                ) : null}
                {plan.current ? (
                  <Badge size="sm" tone="ok">
                    In use
                  </Badge>
                ) : null}
                {plan.id === confirmed ? (
                  <Badge size="sm" tone="accent">
                    Confirmed
                  </Badge>
                ) : null}
              </span>
              <span className="cc-plan__phases">
                {PHASES.map((phase) => (
                  <span key={phase} className="cc-plan__phase" title={plan.phases[phase].problem ?? `${PHASE_INFO[phase].title}: complete`}>
                    <StatusMark status={plan.phases[phase].problem ? 'failed' : 'done'} size={13} />
                    {PHASE_INFO[phase].short}
                  </span>
                ))}
              </span>
              <span className={cx('cc-plan__note', plan.problems.length > 0 && 'cc-tone--warn')} title={plan.problems.join('\n') || undefined}>
                {plan.problems[0] ?? (changed.length ? changed.join(', ') : plan.basedOn ? `Copy of ${planWhen(plan.basedOn, false)}` : 'Complete')}
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}
