import { cx, formatPercent } from '@/shared/lib'
import { DetectionImage } from '@/shared/ui/DetectionImage'
import { Icon } from '@/shared/ui/Icon'
import type { ContentsView } from '../../model/suspicious-item'
import './ContentsPhoto.css'

export interface ContentsPhotoProps {
  contents: ContentsView
  /** stack: the photo over its object list · row: side by side, where the verdict's buttons must stay in view */
  layout?: 'stack' | 'row'
  onExpand?: () => void
  className?: string
}

/** The ALOHA's photos of the box, its two wrist cameras side by side, every object outlined and listed by confidence:
 * the evidence for the verdict. Nothing is filtered out: the operator judges. */
export function ContentsPhoto({ contents, layout = 'stack', onExpand, className }: ContentsPhotoProps) {
  const objects = [...contents.objects].sort((a, b) => b.confidence - a.confidence)
  const ready = contents.state === 'ready'
  return (
    <div className={cx('cc-contents', `is-${contents.state}`, layout === 'row' && 'cc-contents--row', className)}>
      {ready ? (
        <DetectionImage
          src={contents.src ?? undefined}
          alt="The box, from both wrist cameras"
          aspect="auto"
          boxes={objects.map((o) => ({ ...o.box, label: o.label, confidence: o.confidence }))}
          onExpand={onExpand}
        />
      ) : (
        <div className="cc-contents__wait" style={{ aspectRatio: '8 / 3' }}>
          {contents.state === 'capturing' ? (
            <>
              <span className="cc-contents__ring" aria-hidden="true">
                <span>{contents.holdLeft ?? 4}</span>
              </span>
              <span className="cc-contents__msg">Arms held · photographing the box</span>
            </>
          ) : (
            <>
              <Icon name="camera" size={22} />
              <span className="cc-contents__msg">Both wrist cameras photograph the box before the arms go home.</span>
            </>
          )}
        </div>
      )}
      {ready ? (
        <ul className="cc-contents__list">
          {objects.map((o) => (
            <li key={o.label}>
              <span className="cc-contents__name">{o.label}</span>
              <span className="cc-contents__bar" aria-hidden="true">
                <span style={{ width: `${o.confidence * 100}%` }} />
              </span>
              <span className="cc-mono cc-num cc-contents__pct">{formatPercent(o.confidence)}</span>
            </li>
          ))}
          {contents.takenAt ? <li className="cc-contents__when">photo {contents.takenAt}</li> : null}
        </ul>
      ) : null}
    </div>
  )
}
