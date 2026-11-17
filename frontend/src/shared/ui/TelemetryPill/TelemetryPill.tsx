import type { ReactNode } from 'react'
import { cx, type Tone } from '@/shared/lib'
import { StatusDot } from '@/shared/ui/StatusDot'
import './TelemetryPill.css'

export interface TelemetryPillProps {
  label: string
  value?: ReactNode
  /** The dot's tone; null for no dot */
  tone?: Tone | null
  /** Only for a live stream */
  pulse?: boolean
  /** The value in mono, for IDs and domains */
  mono?: boolean
  /** The longer explanation, on hover */
  title?: string
  className?: string
}

/** A status dot, a capitalised label and a value: the header's live readouts */
export function TelemetryPill({ label, value, tone = 'ok', pulse = false, mono = false, title, className }: TelemetryPillProps) {
  return (
    <span className={cx('cc-pill', className)} title={title}>
      {tone ? <StatusDot tone={tone} pulse={pulse} size={7} /> : null}
      <span className="cc-pill__label">{label}</span>
      {value != null ? <span className={cx('cc-pill__value', mono && 'cc-mono')}>{value}</span> : null}
    </span>
  )
}
