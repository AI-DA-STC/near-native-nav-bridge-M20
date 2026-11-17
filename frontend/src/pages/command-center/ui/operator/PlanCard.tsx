import type { ReactNode } from 'react'
import { robotOf } from '@/shared/config'
import { cssVars, cx } from '@/shared/lib'
import { RobotTag } from '@/shared/ui/RobotTag'
import { StatusMark } from '@/shared/ui/StatusMark'
import type { PlanView } from '../../model/operator-turn'
import { PlanStatus } from './PlanStatus'
import './PlanCard.css'

export interface PlanCardProps {
  plan: PlanView
  /** The instruction it answers, shown while it waits for approval */
  showInstruction?: boolean
  hot?: boolean
  /** Dashed border */
  preview?: boolean
  /** Approve plan and Deny */
  actions?: ReactNode
  className?: string
}

/** The plan the operator approves, exactly as the planner wrote it */
export function PlanCard({ plan, showInstruction = false, hot = false, preview = false, actions, className }: PlanCardProps) {
  return (
    <article className={cx('cc-plan', hot && 'is-hot', preview && 'is-preview', className)}>
      <header className="cc-plan__head">
        <div className="cc-plan__titles">
          <div className="cc-plan__eyebrow">
            PLAN <span className="cc-mono">{plan.id}</span>
          </div>
          <div className="cc-plan__title">
            {plan.title}
            {plan.summary ? <span className="cc-plan__summary"> ({plan.summary})</span> : null}
          </div>
        </div>
        <PlanStatus status={plan.status} />
      </header>
      {showInstruction ? (
        <p className="cc-plan__instr">
          <span className="cc-plan__instr-label">Instruction</span>“{plan.instruction}”
        </p>
      ) : null}
      <ul className="cc-plan__robots">
        {plan.steps.map((step) => (
          <li key={step.robot} className="cc-plan__row" style={cssVars({ '--rc': robotOf(step.robot).color })}>
            <RobotTag robot={step.robot} showId={false} swatch="bar" size="sm" />
            <ol className="cc-plan__steps">
              {step.items.map((item, i) => (
                <li key={i} className={cx('cc-plan__step', `is-${item.status}`)}>
                  {item.status !== 'pending' ? <StatusMark status={item.status} size={11} /> : null}
                  {item.text}
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ul>
      {actions ? <div className="cc-plan__actions">{actions}</div> : null}
    </article>
  )
}
