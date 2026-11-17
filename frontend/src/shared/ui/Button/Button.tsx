import { useId, type ComponentProps, type ReactNode } from 'react'
import { cx } from '@/shared/lib'
import { Icon, type IconName } from '@/shared/ui/Icon'
import { Kbd } from '@/shared/ui/Kbd'
import './Button.css'

export interface ButtonProps extends ComponentProps<'button'> {
  /** secondary (default) · primary: the accent, the one thing it is the operator's turn to do, at most once per view ·
   * danger: Force stop and the confirm of Stop mission · finding: ANOMALY only · ghost: tertiary actions */
  variant?: 'secondary' | 'primary' | 'danger' | 'finding' | 'ghost'
  /** sm 26 px · md 32 px · lg 40 px (the operator's decisions) */
  size?: 'sm' | 'md' | 'lg'
  icon?: IconName
  iconRight?: IconName
  /** The key it answers to: "Enter", "Esc" */
  kbd?: string
  /** Why a disabled button is disabled, shown once beside it and wired with aria-describedby */
  reason?: ReactNode
  reasonPlacement?: 'below' | 'right'
  /** A toggle's state (Follow robot): accent tint and aria-pressed */
  pressed?: boolean
  block?: boolean
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  kbd,
  disabled = false,
  reason,
  reasonPlacement = 'below',
  block = false,
  pressed,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const reasonId = useId()
  const iconSize = size === 'sm' ? 14 : 16
  const button = (
    <button
      type={type}
      className={cx(
        'cc-btn',
        `cc-btn--${variant}`,
        `cc-btn--${size}`,
        block && 'cc-btn--block',
        pressed && 'is-pressed',
        className,
      )}
      disabled={disabled}
      aria-pressed={pressed}
      aria-describedby={disabled && reason ? reasonId : undefined}
      {...rest}
    >
      {icon ? <Icon name={icon} size={iconSize} /> : null}
      {children != null ? <span className="cc-btn__label">{children}</span> : null}
      {iconRight ? <Icon name={iconRight} size={iconSize} /> : null}
      {kbd ? <Kbd>{kbd}</Kbd> : null}
    </button>
  )
  if (!(disabled && reason)) return button
  return (
    <span className={cx('cc-btn-wrap', `cc-btn-wrap--${reasonPlacement}`, block && 'cc-btn-wrap--block')}>
      {button}
      <span className="cc-btn-reason" id={reasonId}>
        <Icon name="info" size={13} />
        <span>{reason}</span>
      </span>
    </span>
  )
}
