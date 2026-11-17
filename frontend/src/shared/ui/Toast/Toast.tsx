import type { ReactNode } from 'react'
import { cx } from '@/shared/lib'
import { Icon } from '@/shared/ui/Icon'
import type { ToastTone } from './toast-queue'
import './Toast.css'

const TOAST_ICON = { neutral: 'info', ok: 'done', warn: 'warn', fault: 'fault', finding: 'finding', accent: 'decision' } as const

export interface ToastProps {
  /** Colours the icon only */
  tone?: ToastTone
  title?: ReactNode
  children?: ReactNode
  action?: ReactNode
  onClose?: () => void
  className?: string
}

export function Toast({ tone = 'neutral', title, children, action, onClose, className }: ToastProps) {
  return (
    <div className={cx('cc-toast', `cc-toast--${tone}`, className)} role="status">
      <Icon name={TOAST_ICON[tone]} size={16} className="cc-toast__icon" />
      <div className="cc-toast__text">
        {title ? <div className="cc-toast__title">{title}</div> : null}
        {children ? <div className="cc-toast__body">{children}</div> : null}
      </div>
      {action ? <div className="cc-toast__action">{action}</div> : null}
      {onClose ? (
        <button type="button" className="cc-toast__x" onClick={onClose} aria-label="Dismiss">
          <Icon name="close" size={14} />
        </button>
      ) : null}
    </div>
  )
}

export interface ToastRegionProps {
  children?: ReactNode
  inline?: boolean
}

/** Where toasts stack, bottom right */
export function ToastRegion({ children, inline = false }: ToastRegionProps) {
  return (
    <div className={cx('cc-toasts', inline && 'is-inline')} aria-live="polite">
      {children}
    </div>
  )
}
