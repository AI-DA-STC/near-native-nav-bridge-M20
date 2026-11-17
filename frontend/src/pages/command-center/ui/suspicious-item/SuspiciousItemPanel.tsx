import type { MissionSnapshot } from '@/shared/api'
import { Badge } from '@/shared/ui/Badge'
import { Panel } from '@/shared/ui/Panel'
import { suspiciousItemOf, type ImageView } from '../../model/suspicious-item'
import { CameraFeed } from './CameraFeed'
import { ContentsPhoto } from './ContentsPhoto'
import { FindingCard } from './FindingCard'

export interface SuspiciousItemPanelProps {
  snap: MissionSnapshot
  /** The Operator panel shows the contents photo for the verdict: this panel shows the finding meanwhile */
  contentsInOperator: boolean
  onExpand: (image: ImageView) => void
}

/** R3's camera first, then BOX FOUND, then the ALOHA's photo of the contents; every image opens in the lightbox */
export function SuspiciousItemPanel({ snap, contentsInOperator, onExpand }: SuspiciousItemPanelProps) {
  const item = suspiciousItemOf(snap, contentsInOperator)
  const expand = (image: ImageView | null) => (image ? () => onExpand(image) : undefined)
  return (
    <Panel
      title="Suspicious item"
      scroll
      className="cc-ccpage__item"
      meta={
        <Badge tone={item.status.tone} icon={item.status.icon} size="sm">
          {item.status.text}
        </Badge>
      }
    >
      {item.stage === 'contents' && item.contents ? (
        <ContentsPhoto contents={item.contents} onExpand={expand(item.images.contents)} />
      ) : item.stage === 'finding' && item.finding ? (
        <FindingCard finding={item.finding} onExpand={expand(item.images.finding)} />
      ) : (
        <CameraFeed camera={item.camera} onExpand={expand(item.images.camera)} />
      )}
    </Panel>
  )
}
