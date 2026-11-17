import type { ReactNode } from 'react'
import { cx } from '@/shared/lib'
import { Badge } from '@/shared/ui/Badge'
import { Icon, type IconName } from '@/shared/ui/Icon'
import type { Outcome } from '../../model/operator-turn'
import './OutcomeSummary.css'

const OUTCOME: Record<Outcome, { word: string; icon: IconName; tone: string }> = {
  complete: { word: 'Mission complete', icon: 'done', tone: 'ok' },
  // an anomaly is what the mission is for: a finding, not a failure
  anomaly: { word: 'Mission ended', icon: 'finding', tone: 'finding' },
  failed: { word: 'Mission failed', icon: 'failed', tone: 'fault' },
  stopped: { word: 'Mission stopped', icon: 'stopped', tone: 'neutral' },
  estopped: { word: 'E-STOP', icon: 'stopped', tone: 'fault' },
}

export interface OutcomeSummaryProps {
  outcome: Outcome
  verdict?: 'anomaly' | 'clear' | null
  /** "7:42" */
  total?: string | null
  reason?: ReactNode
  facts?: Array<{ label: string; value: ReactNode; mono?: boolean }>
  className?: string
}

/** The Operator panel after the end: the outcome in a line, the verdict, the total time and the facts that matter */
export function OutcomeSummary({ outcome, verdict, total, reason, facts = [], className }: OutcomeSummaryProps) {
  const o = OUTCOME[outcome]
  return (
    <div className={cx('cc-outcome', `cc-outcome--${o.tone}`, className)}>
      <div className="cc-outcome__head">
        <Icon name={o.icon} size={20} />
        <span className="cc-outcome__word">{o.word}</span>
        {verdict === 'anomaly' ? (
          <Badge tone="finding" variant="solid" icon="finding">
            ANOMALY
          </Badge>
        ) : verdict === 'clear' ? (
          <Badge tone="neutral" variant="outline" icon="done">
            CLEAR
          </Badge>
        ) : null}
        {total ? <span className="cc-outcome__total cc-mono cc-num">{total}</span> : null}
      </div>
      {reason ? <p className="cc-outcome__reason">{reason}</p> : null}
      {facts.length ? (
        <dl className="cc-outcome__facts">
          {facts.map((f) => (
            <div key={f.label}>
              <dt>{f.label}</dt>
              <dd className={f.mono ? 'cc-mono' : undefined}>{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  )
}
