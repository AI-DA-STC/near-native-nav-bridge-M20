import type { CSSProperties } from 'react'
import { isRobotKey, robotOf, type RobotKey } from '@/shared/config'
import { cssVars, cx, type Tone } from '@/shared/lib'
import './StatusDot.css'

export interface StatusDotProps {
  /** A status tone, or a robot key for its identity colour */
  tone?: Tone | RobotKey
  /** Only for things that are live: data arriving, a mission running */
  pulse?: boolean
  /** px, default 8 */
  size?: number
  /** Accessible name, when no word sits beside the dot */
  label?: string
  className?: string
  style?: CSSProperties
}

export function StatusDot({ tone = 'ok', pulse = false, size = 8, label, className, style }: StatusDotProps) {
  const robot = isRobotKey(tone) ? robotOf(tone) : null
  return (
    <span
      className={cx('cc-dot', !robot && `cc-dot--${tone}`, pulse && 'is-pulse', className)}
      style={cssVars(robot ? { '--dot': robot.color } : {}, { width: size, height: size, ...style })}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  )
}
