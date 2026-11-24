import { cx } from '@/shared/lib'
import { Badge } from '@/shared/ui/Badge'
import { Icon } from '@/shared/ui/Icon'
import { StatusMark } from '@/shared/ui/StatusMark'
import type { TrackPhase } from '../../model/phase-track'
import './PhaseBar.css'

export interface PhaseBarProps {
  phases: TrackPhase[]
  /** Once the mission has ended, its total time */
  total?: string | null
  onExpand: () => void
}

/** The phase track minimized to one line: where the mission is (the phase, its time, the operator's turn, a finding) and
 * every phase's mark. The chevron, or a click anywhere on it, opens the full track again. */
export function PhaseBar({ phases, total, onExpand }: PhaseBarProps) {
  const active = phases.find((p) => p.status === 'active')
  const failed = phases.find((p) => p.status === 'failed')
  const last = [...phases].reverse().find((p) => p.status !== 'pending' && p.status !== 'skipped')
  const shown = active ?? failed ?? last ?? phases[0]
  const lastN = phases.length ? phases[phases.length - 1].n : 0
  const waiting = active?.decision ?? false
  return (
    <button type="button" className={cx('cc-trackbar', waiting && 'is-waiting')} aria-expanded="false" aria-label="Mission phases: show them all" onClick={onExpand}>
      <Icon name="chevronDown" size={14} className="cc-trackbar__chev" />
      <span className="cc-trackbar__label">{total ? 'TOTAL' : failed && !active ? 'FAILED' : 'PHASE'}</span>
      <span className="cc-trackbar__count">
        {total ?? (
          <>
            {shown?.n ?? 0}
            <small>/{lastN}</small>
          </>
        )}
      </span>
      {shown ? <span className="cc-trackbar__name">{shown.name}</span> : null}
      {waiting ? <span className="cc-trackbar__turn">Waiting for you</span> : active?.turn ? <span className="cc-trackbar__turn">{active.turn}</span> : null}
      {active?.finding ? (
        <Badge tone="finding" variant="solid" icon="finding" size="sm">
          {active.finding.label} {active.finding.at}
        </Badge>
      ) : null}
      {active?.time ? <span className="cc-trackbar__time">{active.time}</span> : null}
      <span className="cc-trackbar__marks" aria-hidden="true">
        {phases.map((p) => (
          <span key={p.id} className={cx('cc-trackbar__mark', p.status === 'active' && 'is-active')} title={`${p.n} · ${p.name}`}>
            <StatusMark status={p.status === 'active' && p.decision ? 'decision' : p.status} size={12} />
          </span>
        ))}
      </span>
    </button>
  )
}
