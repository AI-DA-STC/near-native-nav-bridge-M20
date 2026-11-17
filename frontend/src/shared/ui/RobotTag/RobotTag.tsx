import type { ReactNode } from 'react'
import { robotOf, type RobotKey } from '@/shared/config'
import { cssVars, cx } from '@/shared/lib'
import { RobotGlyph } from '@/shared/ui/RobotGlyph'
import './RobotTag.css'

export interface RobotTagProps {
  robot: RobotKey
  showId?: boolean
  /** Hides the visible label (screen readers still get it) when the text beside it already names the robot */
  showLabel?: boolean
  /** dot (default) · glyph · bar (lane heads) · none */
  swatch?: 'dot' | 'glyph' | 'bar' | 'none'
  size?: 'sm' | 'md' | 'lg'
  /** For the glyph swatch, degrees */
  heading?: number
  /** A trailing word: "front camera" */
  extra?: ReactNode
  className?: string
}

/** A robot's identity: its colour always beside its label, R1 · 741 */
export function RobotTag({
  robot,
  showId = true,
  showLabel = true,
  swatch = 'dot',
  size = 'md',
  heading = 0,
  extra,
  className,
}: RobotTagProps) {
  const r = robotOf(robot)
  return (
    <span className={cx('cc-rtag', `cc-rtag--${size}`, className)} style={cssVars({ '--rc': r.color })}>
      {swatch === 'dot' ? <span className="cc-rtag__dot" aria-hidden="true" /> : null}
      {swatch === 'bar' ? <span className="cc-rtag__bar" aria-hidden="true" /> : null}
      {swatch === 'glyph' ? <RobotGlyph robot={robot} heading={heading} size={size === 'lg' ? 20 : 16} /> : null}
      {showLabel ? <span className="cc-rtag__label">{r.label}</span> : <span className="cc-sr">{r.label}</span>}
      {showLabel && showId && r.id ? <span className="cc-rtag__id">· {r.id}</span> : null}
      {extra ? <span className="cc-rtag__extra">{extra}</span> : null}
    </span>
  )
}
