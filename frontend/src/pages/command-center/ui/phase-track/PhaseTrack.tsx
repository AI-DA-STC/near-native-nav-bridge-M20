import { robotOf } from '@/shared/config'
import { cssVars, cx } from '@/shared/lib'
import { Badge } from '@/shared/ui/Badge'
import { Icon } from '@/shared/ui/Icon'
import { StatusMark } from '@/shared/ui/StatusMark'
import { phaseColumns } from '../../lib/phase-columns'
import type { PhaseNote, PhaseTrackView, TrackPhase } from '../../model/phase-track'
import type { Lane } from '../../model/task-lanes'
import { TaskLanes } from './TaskLanes'
import './PhaseTrack.css'

const RAIL_FULL = new Set(['done', 'failed', 'skipped'])

function Note({ note }: { note: PhaseNote }) {
  if (typeof note === 'string') return <span className="cc-phase__note">{note}</span>
  return note.verdict === 'anomaly' ? (
    <Badge tone="finding" variant="solid" icon="finding" size="sm">
      ANOMALY
    </Badge>
  ) : (
    <Badge tone="neutral" variant="outline" icon="done" size="sm">
      CLEAR
    </Badge>
  )
}

function PhaseCell({ p, compact }: { p: TrackPhase; compact: boolean }) {
  const status = p.status
  const active = status === 'active'
  const waiting = p.decision && active
  const progress = RAIL_FULL.has(status) ? 1 : active || status === 'stopped' ? Math.max(0.04, Math.min(1, p.progress ?? 0.5)) : 0
  const you = p.decision ? (
    <span className="cc-phase__you" title="Operator decision">
      <Icon name="decision" size={10} />
      YOU
    </span>
  ) : null
  const fallback = status === 'skipped' ? 'Skipped' : status === 'stopped' ? 'Stopped' : status === 'failed' ? 'Failed' : null
  const note = p.note ? <Note note={p.note} /> : fallback ? <span className="cc-phase__note">{fallback}</span> : null
  return (
    <li className={cx('cc-phase', `is-${status}`, p.decision && 'is-decision', waiting && 'is-waiting')} aria-current={active ? 'step' : undefined}>
      <div className="cc-phase__top">
        <span className="cc-phase__n">{p.n}</span>
        <StatusMark status={waiting ? 'decision' : status} size={active && !compact ? 18 : 14} label={waiting ? 'Waiting for you' : undefined} />
        {waiting ? <span className="cc-phase__turn">Waiting for you</span> : null}
        {active && !waiting && p.turn ? <span className="cc-phase__turn">{p.turn}</span> : null}
        {active && p.finding && !compact ? (
          <Badge tone="finding" variant="solid" icon="finding" size="sm">
            {p.finding.label} {p.finding.at}
          </Badge>
        ) : null}
        {active && p.time ? <span className="cc-phase__time is-live">{p.time}</span> : null}
        {!active ? you : null}
      </div>
      <div className="cc-phase__name">{p.name}</div>
      {!active && (note || p.time) ? (
        <div className="cc-phase__meta">
          {note}
          {p.time ? <span className="cc-phase__time">{p.time}</span> : null}
        </div>
      ) : null}
      {active && note ? <div className="cc-phase__meta">{note}</div> : null}
      {active && !compact && p.sub ? (
        <div className="cc-phase__sub">
          {typeof p.sub === 'string' ? (
            // one item per part, so a long line wraps between them
            p.sub.split(' · ').map((part) => (
              <span key={part} className="cc-phase__subitem">
                {part}
              </span>
            ))
          ) : (
            p.sub.map((s) => (
              <span key={s.robot} className="cc-phase__subitem" style={cssVars({ '--rc': robotOf(s.robot).color })}>
                <span className="cc-phase__subdot" />
                <b>{robotOf(s.robot).label}</b> {s.text}
              </span>
            ))
          )}
        </div>
      ) : null}
      <div className="cc-phase__rail" aria-hidden="true">
        <span style={{ width: `${progress * 100}%` }} />
      </div>
    </li>
  )
}

export interface PhaseTrackProps {
  phases: TrackPhase[]
  loops?: PhaseTrackView['loops']
  /** The task lanes, under the same columns */
  lanes?: Lane[]
  lanesMode?: 'full' | 'bars' | 'hidden'
  /** The lanes show the plan waiting for approval as a dashed preview */
  preview?: boolean
  /** 1280×720 */
  compact?: boolean
  /** Replaces PHASE n/8 once the mission has ended */
  total?: string | null
  /** Shrinks it to one line (PhaseBar) */
  onMinimize?: () => void
  className?: string
}

/** The hero: phases 0–8 left to right, readable from across the room */
export function PhaseTrack({ phases, loops = [], lanes, lanesMode = 'full', preview = false, compact = false, total, onMinimize, className }: PhaseTrackProps) {
  const columns = phaseColumns(phases)
  const active = phases.find((p) => p.status === 'active')
  const failed = phases.find((p) => p.status === 'failed')
  const done = phases.filter((p) => p.status === 'done')
  const lastN = phases.length ? phases[phases.length - 1].n : 0
  const headLabel = active ? 'PHASE' : failed ? 'FAILED' : done.length ? 'ENDED' : 'PHASE'
  const headN = active ? active.n : failed ? failed.n : done.length ? done[done.length - 1].n : 0
  const indexOf = (id: string) => phases.findIndex((p) => p.id === id)
  return (
    <div className={cx('cc-track', compact && 'cc-track--compact', className)} role="group" aria-label="Mission phases">
      {onMinimize ? (
        <button type="button" className="cc-track__min" aria-expanded="true" aria-label="Minimize the phases" title="Minimize the phases" onClick={onMinimize}>
          <Icon name="chevronDown" size={14} />
        </button>
      ) : null}
      <ol className="cc-track__row" style={{ gridTemplateColumns: columns }}>
        <li className="cc-track__head" aria-hidden="true">
          {total ? (
            <>
              <span className="cc-track__label">TOTAL</span>
              <span className="cc-track__count" style={{ fontSize: 20 }}>
                {total}
              </span>
            </>
          ) : (
            <>
              <span className={cx('cc-track__label', failed && !active && 'is-failed')}>{headLabel}</span>
              <span className="cc-track__count">
                {headN}
                <small>/{lastN}</small>
              </span>
            </>
          )}
        </li>
        {phases.map((p) => (
          <PhaseCell key={p.id} p={p} compact={compact} />
        ))}
        {loops.map((loop) => {
          const to = indexOf(loop.to)
          const from = indexOf(loop.from)
          if (to < 0 || from < 0) return null
          return (
            <li key={`${loop.from}-${loop.to}`} className="cc-track__loop" style={{ gridColumn: `${to + 2} / ${from + 3}` }}>
              <span className="cc-track__loopline" aria-hidden="true" />
              <span className="cc-track__looplabel">
                <Icon name="loop" size={12} />
                Denied ×{loop.count} · back to {phases[to].name}
              </span>
            </li>
          )
        })}
      </ol>
      {lanes && lanesMode !== 'hidden' ? <TaskLanes phases={phases} lanes={lanes} mode={lanesMode} preview={preview} embedded template={columns} /> : null}
    </div>
  )
}
