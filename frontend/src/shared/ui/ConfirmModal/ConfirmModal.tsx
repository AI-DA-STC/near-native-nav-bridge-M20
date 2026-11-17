import { useId, type ReactNode } from 'react'
import { cx } from '@/shared/lib'
import { Button } from '@/shared/ui/Button'
import { Icon, type IconName } from '@/shared/ui/Icon'
import { Scrim } from '@/shared/ui/Scrim'
import './ConfirmModal.css'

export interface ConfirmModalProps {
  open?: boolean
  /** A question: "Approve plan SR2-01?" */
  title: ReactNode
  /** What happens next, one or two sentences */
  children?: ReactNode
  /** Repeats the verb: "Approve plan", "Stop mission", "Mark ANOMALY" */
  confirmLabel?: string
  cancelLabel?: string
  /** Colours the confirm button and the title's icon */
  tone?: 'accent' | 'danger' | 'finding'
  icon?: IconName
  onConfirm?: () => void
  onCancel?: () => void
  /** Renders in place, for documentation */
  inline?: boolean
  className?: string
}

const CONFIRM_VARIANT = { accent: 'primary', danger: 'danger', finding: 'finding' } as const

/** The confirm step for Approve plan, the verdict and Stop mission, never for E-STOP. Focus starts on the confirm
 * button, so Enter confirms and Esc cancels. */
export function ConfirmModal({
  open = true,
  title,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'accent',
  icon,
  onConfirm,
  onCancel,
  inline = false,
  className,
}: ConfirmModalProps) {
  const titleId = useId()
  if (!open) return null
  return (
    <Scrim inline={inline} onDismiss={onCancel}>
      <div
        className={cx('cc-modal', `cc-modal--${tone}`, className)}
        role="dialog"
        aria-modal={inline ? undefined : true}
        aria-labelledby={titleId}
      >
        <h2 className="cc-modal__title" id={titleId}>
          {icon ? <Icon name={icon} size={18} /> : null}
          {title}
        </h2>
        <div className="cc-modal__body">{children}</div>
        <div className="cc-modal__actions">
          <Button onClick={onCancel} kbd="Esc">
            {cancelLabel}
          </Button>
          <Button variant={CONFIRM_VARIANT[tone]} onClick={onConfirm} kbd="Enter" autoFocus={!inline}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Scrim>
  )
}
