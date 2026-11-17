import { cx } from '@/shared/lib'
import { StatusDot } from '@/shared/ui/StatusDot'
import './MissionClock.css'

export interface MissionClockProps {
  /** mm:ss */
  time?: string
  /** ELAPSED; TOTAL once the mission has ended */
  label?: string
  /** A live dot pulses while it runs */
  running?: boolean
  className?: string
}

/** The whole mission's elapsed time in tabular mono, readable from 2 m */
export function MissionClock({ time = '00:00', label = 'ELAPSED', running = false, className }: MissionClockProps) {
  return (
    <div className={cx('cc-clock', className)} role="timer" aria-label={`${label} ${time}`}>
      <span className="cc-clock__label">
        {running ? <StatusDot tone="live" pulse size={6} /> : null}
        {label}
      </span>
      <span className="cc-clock__time">{time}</span>
    </div>
  )
}
