import type { ReactNode } from 'react'
import { cx } from '@/shared/lib'
import './Kbd.css'

export interface KbdProps {
  /** The key as printed on the keyboard: Enter, Esc, Shift, ← */
  children: ReactNode
  className?: string
}

/** The key a control answers to, in mono on the well colour. E-STOP has none, on purpose. */
export function Kbd({ children, className }: KbdProps) {
  return <kbd className={cx('cc-kbd', className)}>{children}</kbd>
}
