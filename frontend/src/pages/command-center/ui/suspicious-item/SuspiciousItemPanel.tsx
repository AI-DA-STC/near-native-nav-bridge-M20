import type { MissionSnapshot } from '@/shared/api'
import { Badge } from '@/shared/ui/Badge'
import { Panel } from '@/shared/ui/Panel'
import { suspiciousItemOf, type ImageView } from '../../model/suspicious-item'
import { ContentsPhoto } from './ContentsPhoto'
import { FindingCard } from './FindingCard'

export interface SuspiciousItemPanelProps {
  snap: MissionSnapshot
  /** The Operator panel shows the contents photo for the verdict: this panel shows the finding meanwhile */
  contentsInOperator: boolean
  onExpand: (image: ImageView) => void
}

/** What it waits for, then the box R3 found with R3's photo of it, then the ALOHA's photo of the contents; every image
 * opens in the lightbox. R3 finds the box by reaching it on its sweep (demo/find_box.py). */
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
        <FindingCard
          finding={item.finding}
          title={item.finding.atKnownPlace ? 'Anomalous object identified' : undefined}
          onExpand={expand(item.images.finding)}
        />
      ) : (
        <div className="cc-ccpage__itemwait">
          <p>R3 sweeps toward the box. When it stops there, its photo of the box shows here.</p>
          <p>Then the ALOHA drives to the box and photographs what is inside; that photo shows here too, for your verdict.</p>
        </div>
      )}
    </Panel>
  )
}
