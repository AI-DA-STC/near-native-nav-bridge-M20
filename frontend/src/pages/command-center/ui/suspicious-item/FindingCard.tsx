import { robotOf, type RobotKey } from '@/shared/config'
import { cx, formatNumber, formatPercent } from '@/shared/lib'
import { Badge } from '@/shared/ui/Badge'
import { DetectionImage } from '@/shared/ui/DetectionImage'
import { RobotTag } from '@/shared/ui/RobotTag'
import type { FindingView } from '../../model/suspicious-item'
import './FindingCard.css'

export interface FindingCardProps {
  finding: FindingView
  by?: RobotKey
  title?: string
  onExpand?: () => void
  className?: string
}

/** BOX FOUND, framed by the finding's corner brackets, never fault red; it updates in place on refinement */
export function FindingCard({ finding, by = 'r3', title = 'BOX FOUND', onExpand, className }: FindingCardProps) {
  const r = robotOf(by)
  return (
    <article className={cx('cc-finding', className)}>
      <i className="cc-finding__c is-tl" />
      <i className="cc-finding__c is-tr" />
      <i className="cc-finding__c is-br" />
      <i className="cc-finding__c is-bl" />
      <header className="cc-finding__head">
        <Badge tone="finding" variant="solid" icon="finding">
          {title}
        </Badge>
        <span className="cc-finding__by">
          by <RobotTag robot={by} size="sm" />
        </span>
        {finding.refinements ? (
          <Badge tone="finding" size="sm">
            refined ×{finding.refinements}
          </Badge>
        ) : null}
      </header>
      <div className="cc-finding__body">
        <DetectionImage src={finding.snapshot} alt="Snapshot of the box" boxes={finding.detection ? [finding.detection] : []} aspect="4 / 3" onExpand={onExpand} />
        <dl className="cc-finding__facts">
          <div>
            <dt>X</dt>
            <dd className="cc-mono cc-num">{formatNumber(finding.x)} m</dd>
          </div>
          <div>
            <dt>Y</dt>
            <dd className="cc-mono cc-num">{formatNumber(finding.y)} m</dd>
          </div>
          <div>
            <dt>Distance</dt>
            <dd className="cc-mono cc-num">
              {formatNumber(finding.dist, 1)} m <small>from {r.label}</small>
            </dd>
          </div>
          <div>
            <dt>Confidence</dt>
            <dd className="cc-mono cc-num">
              {formatPercent(finding.confidence)}
              <span className="cc-finding__conf" aria-hidden="true">
                <span style={{ width: `${finding.confidence * 100}%` }} />
              </span>
            </dd>
          </div>
          <div>
            <dt>Found</dt>
            <dd className="cc-mono cc-num">{finding.foundAt}</dd>
          </div>
          <div>
            <dt>Refined</dt>
            <dd className="cc-mono cc-num">{finding.refinedAt ?? '—'}</dd>
          </div>
        </dl>
      </div>
    </article>
  )
}
