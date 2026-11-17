import { robotOf } from '@/shared/config'
import { cssVars, cx } from '@/shared/lib'
import { Icon, type IconName } from '@/shared/ui/Icon'
import { RobotTag } from '@/shared/ui/RobotTag'
import { phaseColumns } from '../../lib/phase-columns'
import type { TrackPhase } from '../../model/phase-track'
import type { Lane } from '../../model/task-lanes'
import './TaskLanes.css'

const LANE_MARK: Partial<Record<string, IconName>> = { done: 'done', active: 'active', failed: 'failed', stopped: 'stopped', skipped: 'skipped', wait: 'wait' }

export interface TaskLanesProps {
  phases: TrackPhase[]
  lanes: Lane[]
  /** full: text cells · bars: 4 px bars, at 1280×720 · hidden */
  mode?: 'full' | 'bars' | 'hidden'
  /** Every pending cell becomes a dashed preview: the plan waiting for approval */
  preview?: boolean
  /** Under the phase track's columns */
  embedded?: boolean
  template?: string
  className?: string
}

/** One lane per robot, one cell per phase: who does what, and who waits on whom */
export function TaskLanes({ phases, lanes, mode = 'full', preview = false, embedded = false, template, className }: TaskLanesProps) {
  const columns = template ?? phaseColumns(phases)
  return (
    <div className={cx('cc-lanes', `cc-lanes--${mode}`, embedded && 'is-embedded', className)} role="table" aria-label="Task lanes">
      {lanes.map((lane) => {
        const r = robotOf(lane.robot)
        return (
          <div key={r.key} className="cc-lane" role="row" style={cssVars({ '--rc': r.color }, { gridTemplateColumns: columns })}>
            <div className="cc-lane__head" role="rowheader">
              <RobotTag robot={r.key} showId={false} swatch="bar" size="sm" />
            </div>
            {phases.map((p) => {
              const cell = lane.cells[p.id]
              const state = preview && cell.state === 'pending' ? 'preview' : cell.state
              const mark = LANE_MARK[state]
              return (
                <div key={p.id} role="cell" className={cx('cc-lane__cell', `is-${state}`)} title={`${r.label}: ${cell.text}`}>
                  {mode === 'bars' ? (
                    <span className="cc-lane__bar">
                      <span style={{ width: `${(state === 'active' ? Math.max(0.08, cell.progress ?? 0.5) : state === 'done' ? 1 : 0) * 100}%` }} />
                    </span>
                  ) : (
                    <>
                      {mark && state !== 'active' ? <Icon name={mark} size={11} className="cc-lane__mark" /> : null}
                      <span className="cc-lane__text">{cell.text}</span>
                      {state === 'active' && cell.progress !== null ? (
                        <span className="cc-lane__prog" aria-hidden="true">
                          <span style={{ width: `${Math.max(0.04, cell.progress) * 100}%` }} />
                        </span>
                      ) : null}
                    </>
                  )}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
