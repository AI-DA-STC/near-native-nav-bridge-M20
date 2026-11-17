import type { ReactNode } from 'react'
import { cx } from '@/shared/lib'
import { Icon } from '@/shared/ui/Icon'
import './OperatorPrompt.css'

export interface OperatorPromptProps {
  /** Capitals, after ◆: "YOUR DECISION · PLAN APPROVAL", "NEXT DECISION · VERDICT" */
  eyebrow?: ReactNode
  /** The question, or the situation now */
  question?: ReactNode
  detail?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
}

/** What the Operator panel says: what happens next and why, one question at a time */
export function OperatorPrompt({ eyebrow, question, detail, actions, children, className }: OperatorPromptProps) {
  return (
    <div className={cx('cc-oprompt', className)}>
      {eyebrow ? (
        <div className="cc-oprompt__eyebrow">
          <Icon name="decision" size={11} />
          {eyebrow}
        </div>
      ) : null}
      {question ? <p className="cc-oprompt__q">{question}</p> : null}
      {detail ? <p className="cc-oprompt__detail">{detail}</p> : null}
      {children}
      {actions ? <div className="cc-oprompt__actions">{actions}</div> : null}
    </div>
  )
}
