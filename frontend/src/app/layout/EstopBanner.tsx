import type { RobotKey } from '@/shared/config'
import { cx } from '@/shared/lib'
import { Button } from '@/shared/ui/Button'
import { Icon } from '@/shared/ui/Icon'
import { RobotTag } from '@/shared/ui/RobotTag'
import './EstopBanner.css'

export interface EstopResult {
  robot: RobotKey
  confirmed?: boolean
  /** ms */
  latency?: number | null
  pending?: boolean
  reason?: string | null
}

export interface EstopBannerProps {
  /** Clock time it fired: "10:41:52" */
  firedAt?: string
  /** Every robot in the fleet's order, confirmed or not */
  results: EstopResult[]
  onDismiss?: () => void
  inline?: boolean
  className?: string
}

/** Within 3 s of E-STOP, each robot: confirmed with its latency, or NOT CONFIRMED with the reason. It stays until
 * dismissed, above everything. */
export function EstopBanner({ firedAt, results, onDismiss, inline = false, className }: EstopBannerProps) {
  const confirmed = results.filter((r) => r.confirmed).length
  const waiting = results.filter((r) => r.pending).length
  return (
    <div className={cx('cc-estopban', inline && 'is-inline', className)} role="alert">
      <div className="cc-estopban__head">
        <span className="cc-estopban__title">E-STOP SENT</span>
        {firedAt ? <span className="cc-estopban__at cc-mono">{firedAt}</span> : null}
        <span className="cc-estopban__sum">
          {confirmed}/{results.length} confirmed{waiting ? ` · waiting for ${waiting}` : ''}
        </span>
        <span className="cc-estopban__spacer" />
        {onDismiss ? (
          <Button size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        ) : null}
      </div>
      <ul className="cc-estopban__rows">
        {results.map((r) => (
          <li key={r.robot} className={cx('cc-estopban__row', r.confirmed ? 'is-ok' : r.pending ? 'is-pending' : 'is-bad')}>
            <RobotTag robot={r.robot} />
            {r.confirmed ? (
              <span className="cc-estopban__res">
                <Icon name="done" size={14} /> confirmed <span className="cc-mono cc-num">{r.latency} ms</span>
              </span>
            ) : r.pending ? (
              <span className="cc-estopban__res">
                <span className="cc-spinner cc-spinner--sm" aria-hidden="true" /> waiting…
              </span>
            ) : (
              <span className="cc-estopban__res">
                <Icon name="failed" size={14} /> <b>NOT CONFIRMED</b> {r.reason ? <span className="cc-estopban__why">({r.reason})</span> : null}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
