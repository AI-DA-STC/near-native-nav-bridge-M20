import type { ReactNode } from 'react'
import { cx } from '@/shared/lib'
import './StateChip.css'

/** The mission's state, readable from the back of the room */
export type MissionState = 'ready' | 'not-ready' | 'running' | 'waiting' | 'stopping' | 'ended' | 'failed' | 'estopped'

const STATES: Record<MissionState, { word: string; tone: string; dot?: boolean; pulse?: boolean }> = {
  ready: { word: 'READY', tone: 'ok', dot: true },
  'not-ready': { word: 'NOT READY', tone: 'warn', dot: true },
  running: { word: 'RUNNING', tone: 'ok', dot: true, pulse: true },
  waiting: { word: 'WAITING FOR YOU', tone: 'accent' },
  stopping: { word: 'STOPPING', tone: 'warn', dot: true, pulse: true },
  // a CLEAR or an ANOMALY ending is still just ENDED: an anomaly is a finding, not a failure
  ended: { word: 'ENDED', tone: 'neutral', dot: true },
  failed: { word: 'ENDED (FAILED)', tone: 'fault', dot: true },
  estopped: { word: 'E-STOPPED', tone: 'estop' },
}

export interface StateChipProps {
  state?: MissionState
  /** Overrides the word */
  label?: string
  /** One short clause after the word: "Robot 665 not connected" */
  detail?: ReactNode
  className?: string
}

export function StateChip({ state = 'ready', label, detail, className }: StateChipProps) {
  const s = STATES[state]
  return (
    <div className={cx('cc-state', `cc-state--${s.tone}`, `cc-state--${state}`, className)} role="status" aria-live="polite">
      {s.dot ? <span className={cx('cc-state__dot', s.pulse && 'is-pulse')} aria-hidden="true" /> : null}
      <span className="cc-state__word">{label || s.word}</span>
      {detail ? <span className="cc-state__detail">{detail}</span> : null}
    </div>
  )
}
