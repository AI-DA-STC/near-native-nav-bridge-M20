import type { ReactNode } from 'react'
import { cx, type Tone } from '@/shared/lib'
import { Icon, type IconName } from '@/shared/ui/Icon'
import { STEP_MARKS, type StepStatus } from '@/shared/ui/StatusMark'
import './Badge.css'

export interface BadgeProps {
  tone?: Tone
  /** tint (default) · solid: only a finding (BOX FOUND, ANOMALY) and the accent · outline: CLEAR */
  variant?: 'tint' | 'solid' | 'outline'
  icon?: IconName
  /** Draws a step status's mark */
  mark?: StepStatus
  /** sm 18 px · md 22 px · lg 30 px */
  size?: 'sm' | 'md' | 'lg'
  caps?: boolean
  title?: string
  className?: string
  children?: ReactNode
}

/** One or two words of state in a pill */
export function Badge({ tone = 'neutral', variant = 'tint', icon, mark, size = 'md', caps = false, title, className, children }: BadgeProps) {
  const iconSize = size === 'sm' ? 11 : 13
  return (
    <span
      className={cx('cc-badge', `cc-badge--${tone}`, `cc-badge--${variant}`, `cc-badge--${size}`, caps && 'cc-badge--caps', className)}
      title={title}
    >
      {mark ? <Icon name={STEP_MARKS[mark].icon} size={iconSize} /> : null}
      {icon ? <Icon name={icon} size={iconSize} /> : null}
      <span>{children}</span>
    </span>
  )
}
