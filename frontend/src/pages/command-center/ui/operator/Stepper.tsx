import { cx } from '@/shared/lib'
import { Icon } from '@/shared/ui/Icon'
import { STEP_MARKS } from '@/shared/ui/StatusMark'
import './Stepper.css'

export interface StepperProps {
  steps: Array<{ label: string; status?: 'pending' | 'active' | 'done' | 'failed' | 'skipped' | 'stopped'; n?: number }>
  /** Every step's label, not only the active one's */
  showLabels?: boolean
  className?: string
}

/** A short numbered sequence inside a panel, such as the bring-up checklist before Start */
export function Stepper({ steps, showLabels = false, className }: StepperProps) {
  return (
    <ol className={cx('cc-stepper', className)}>
      {steps.map((step, i) => {
        const status = step.status ?? 'pending'
        const on = status === 'active'
        return (
          <li key={step.label} className={cx('cc-step', `is-${status}`)} aria-current={on ? 'step' : undefined} title={`${step.label} · ${STEP_MARKS[status].word}`}>
            <span className="cc-step__n">{status === 'failed' ? <Icon name="failed" size={11} /> : (step.n ?? i + 1)}</span>
            {on || showLabels ? <span className="cc-step__label">{step.label}</span> : null}
          </li>
        )
      })}
    </ol>
  )
}
