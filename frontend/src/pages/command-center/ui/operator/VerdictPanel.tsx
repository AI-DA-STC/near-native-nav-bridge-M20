import { cx } from '@/shared/lib'
import { Badge } from '@/shared/ui/Badge'
import { Button } from '@/shared/ui/Button'
import './VerdictPanel.css'

export interface VerdictPanelProps {
  decided?: 'anomaly' | 'clear' | null
  /** Each opens the confirm step */
  onAnomaly?: () => void
  onClear?: () => void
  disabled?: boolean
  reason?: string
  decidedAt?: string
  className?: string
}

/** ANOMALY or CLEAR. ANOMALY is a finding (lime, the reticle), never a failure; CLEAR is neutral. Neither is
 * pre-selected. */
export function VerdictPanel({ decided = null, onAnomaly, onClear, disabled = false, reason, decidedAt, className }: VerdictPanelProps) {
  if (decided) {
    return (
      <div className={cx('cc-verdict', 'is-decided', className)}>
        <span className="cc-verdict__label">Verdict</span>
        {decided === 'anomaly' ? (
          <Badge tone="finding" variant="solid" icon="finding" size="lg">
            ANOMALY
          </Badge>
        ) : (
          <Badge tone="neutral" variant="outline" icon="done" size="lg">
            CLEAR
          </Badge>
        )}
        {decidedAt ? <span className="cc-verdict__when cc-mono">decided {decidedAt}</span> : null}
      </div>
    )
  }
  return (
    <div className={cx('cc-verdict', className)}>
      <div className="cc-verdict__buttons">
        <Button variant="finding" size="lg" icon="finding" onClick={onAnomaly} disabled={disabled}>
          ANOMALY
        </Button>
        <Button variant="secondary" size="lg" icon="done" onClick={onClear} disabled={disabled}>
          CLEAR
        </Button>
      </div>
      <p className="cc-verdict__hint">
        {disabled && reason ? reason : 'You confirm in the next step. ANOMALY ends the mission here; CLEAR sends the dogs back to formation.'}
      </p>
    </div>
  )
}
