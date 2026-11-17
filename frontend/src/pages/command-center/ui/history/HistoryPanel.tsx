import { useState } from 'react'
import type { MissionSnapshot } from '@/shared/api'
import { Panel } from '@/shared/ui/Panel'
import { SegmentedControl } from '@/shared/ui/SegmentedControl'
import { Terminal } from '@/shared/ui/Terminal'
import { outputOf, planHistoryOf, timelineOf } from '../../model/history'
import { LogTag } from './LogTag'
import { PlanHistory } from './PlanHistory'
import { Timeline } from './Timeline'

type HistoryView = 'timeline' | 'output' | 'plans'

const VIEWS = [
  { value: 'timeline' as const, label: 'Timeline' },
  { value: 'output' as const, label: 'Output' },
  { value: 'plans' as const, label: 'Plans' },
]

/** The mission's history, the script's raw output and the plan history in one panel that scrolls inside. At 1280×720 it
 * collapses to one bar that still shows the last event. */
export function HistoryPanel({ snap, compact = false }: { snap: MissionSnapshot; compact?: boolean }) {
  const [view, setView] = useState<HistoryView>('timeline')
  const [open, setOpen] = useState(false)
  const collapsed = compact && !open
  const entries = timelineOf(snap)
  const last = entries[entries.length - 1]
  return (
    <Panel
      title="History"
      scroll
      flush
      collapsible={compact}
      collapsed={compact ? collapsed : undefined}
      onToggle={(nowCollapsed) => setOpen(!nowCollapsed)}
      className="cc-ccpage__history"
      meta={
        collapsed ? (
          last ? (
            <span className="cc-ccpage__last cc-mono">
              <span className="cc-num">{last.time}</span> <LogTag tag={last.tag} /> <span className="cc-ccpage__last-text">{last.text}</span>
            </span>
          ) : null
        ) : (
          <SegmentedControl options={VIEWS} value={view} onChange={setView} label="History view" />
        )
      }
    >
      {view === 'timeline' ? (
        <div className="cc-ccpage__history-pad">
          <Timeline entries={entries} />
        </div>
      ) : view === 'output' ? (
        <div className="cc-ccpage__history-pad">
          <Terminal text={outputOf(snap)} />
        </div>
      ) : (
        <PlanHistory rows={planHistoryOf(snap)} />
      )}
    </Panel>
  )
}
