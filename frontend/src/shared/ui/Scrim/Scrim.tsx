import { useEffect, useEffectEvent, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cx } from '@/shared/lib'
import './Scrim.css'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export interface ScrimProps {
  /** The lightbox's darker scrim, which sits above modals */
  dark?: boolean
  /** Renders in place without a portal, for documentation and for testing the dialog alone */
  inline?: boolean
  /** Esc, or a press on the scrim outside the dialog */
  onDismiss?: () => void
  children: ReactNode
}

/** What a modal or the lightbox sits on: it dims the page, closes on Esc or a press outside, keeps Tab inside the
 * dialog and gives focus back to whatever had it on close */
export function Scrim({ dark = false, inline = false, onDismiss, children }: ScrimProps) {
  const ref = useRef<HTMLDivElement>(null)
  const dismiss = useEffectEvent(() => onDismiss?.())

  useEffect(() => {
    if (inline) return undefined
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        dismiss()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (opener?.isConnected) opener.focus()
    }
  }, [inline])

  // Tab and Shift+Tab cycle inside the dialog
  const trapTab = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !ref.current) return
    const focusable = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  if (inline) return <div className="cc-scrim is-inline">{children}</div>
  return createPortal(
    <div
      ref={ref}
      className={cx('cc-scrim', dark && 'cc-scrim--dark')}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDismiss?.()
      }}
      onKeyDown={trapTab}
    >
      {children}
    </div>,
    document.body,
  )
}
