import { robotOf, type RobotKey } from '@/shared/config'
import { cssVars, cx } from '@/shared/lib'
import './RobotGlyph.css'

export interface RobotGlyphProps {
  robot: RobotKey
  /** Degrees in the map frame: 0 = +x, counter-clockwise */
  heading?: number
  size?: number
  /** Accent ring */
  selected?: boolean
  /** No position yet */
  dim?: boolean
  title?: string
  className?: string
}

/** The robot's shape pointing where it heads: the dogs share one chevron, the ALOHA is a rectangle with two arm dots */
export function RobotGlyph({ robot, heading = 0, size = 20, selected = false, dim = false, title, className }: RobotGlyphProps) {
  const r = robotOf(robot)
  return (
    <svg
      className={cx('cc-glyph', selected && 'is-selected', dim && 'is-dim', className)}
      width={size}
      height={size}
      viewBox="-12 -12 24 24"
      style={cssVars({ '--rc': r.color })}
      role="img"
      aria-label={title || r.label}
    >
      {selected ? <circle className="cc-glyph__sel" r="11" /> : null}
      <g transform={`rotate(${-heading})`}>
        {r.kind === 'aloha' ? (
          <g>
            <rect className="cc-glyph__body cc-glyph__body--aloha" x="-8.2" y="-6.2" width="14.4" height="12.4" rx="2.4" />
            <circle className="cc-glyph__arm" cx="6.4" cy="-3.9" r="2.3" />
            <circle className="cc-glyph__arm" cx="6.4" cy="3.9" r="2.3" />
          </g>
        ) : (
          <path className="cc-glyph__body" d="M9.4 0L-6.6 7.4L-2.9 0L-6.6 -7.4Z" />
        )}
      </g>
    </svg>
  )
}
