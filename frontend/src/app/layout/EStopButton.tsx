import type { ComponentProps } from 'react'
import { cx } from '@/shared/lib'
import './EStopButton.css'

export interface EStopButtonProps extends Omit<ComponentProps<'button'>, 'onClick'> {
  /** Fires at once: no confirm step, no keyboard shortcut, never disabled */
  onClick?: () => void
  /** md 32 px in the header; lg 44 px for touch */
  size?: 'md' | 'lg'
  label?: string
}

/** The emergency stop: one click stops every robot at once. The rightmost item of the Command center's header. */
export function EStopButton({ onClick, size = 'md', label = 'E-STOP', className, ...rest }: EStopButtonProps) {
  return (
    <button type="button" className={cx('cc-estop', `cc-estop--${size}`, className)} onClick={onClick} {...rest}>
      {label}
    </button>
  )
}
