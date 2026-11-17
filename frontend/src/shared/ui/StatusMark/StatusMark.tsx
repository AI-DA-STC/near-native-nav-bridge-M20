import { cx } from '@/shared/lib'
import { Icon } from '@/shared/ui/Icon'
import { STEP_MARKS, type StepStatus } from './step-marks'
import './StatusMark.css'

export interface StatusMarkProps {
  status?: StepStatus
  /** Overrides the word (Pending, Active, Done, Failed, Stopped, Skipped, Your decision) */
  label?: string
  /** Prints the word after the mark; otherwise it is the mark's accessible name */
  showLabel?: boolean
  size?: number
  className?: string
}

/** A step's mark in its tone, with its word for screen readers */
export function StatusMark({ status = 'pending', label, showLabel = false, size = 16, className }: StatusMarkProps) {
  const step = STEP_MARKS[status]
  const word = label || step.word
  return (
    <span className={cx('cc-mark', `cc-tone--${step.tone}`, className)} title={showLabel ? undefined : word}>
      <Icon name={step.icon} size={size} title={showLabel ? undefined : word} />
      {showLabel ? <span className="cc-mark__label">{word}</span> : null}
    </span>
  )
}
