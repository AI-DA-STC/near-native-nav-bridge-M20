import { isRobotKey, robotOf, type RobotKey } from '@/shared/config'
import { cssVars, cx, type Tone } from '@/shared/lib'
import './ProgressBar.css'

export interface ProgressBarProps {
  value?: number
  max?: number
  /** One segment per waypoint, up to 6: "WP 2 of 3" reads as two filled segments */
  segments?: number
  /** live (default), a status tone, or a robot key to draw that robot's own route progress */
  tone?: Tone | RobotKey
  /** px, default 4 */
  height?: number
  /** Moving stripes, only while that thing is running */
  animated?: boolean
  /** Accessible name */
  label?: string
  className?: string
}

const clamp = (f: number) => Math.max(0, Math.min(1, f))

export function ProgressBar({
  value = 0,
  max = 1,
  segments = 0,
  tone = 'live',
  height = 4,
  animated = false,
  label,
  className,
}: ProgressBarProps) {
  const robot = isRobotKey(tone) ? robotOf(tone) : null
  const style = cssVars(robot ? { '--bar': robot.color } : {}, { height })
  const classes = (...more: Array<string | false>) =>
    cx('cc-bar', ...more, !robot && `cc-bar--${tone}`, animated && 'is-animated', className)
  const aria = { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': max, 'aria-valuenow': value, 'aria-label': label }
  if (segments > 0) {
    const per = max / segments
    return (
      <div className={classes('cc-bar--seg')} style={style} {...aria}>
        {Array.from({ length: segments }, (_, i) => {
          const fill = clamp((value - i * per) / per)
          return (
            <span key={i} className={cx('cc-bar__seg', fill >= 1 && 'is-full', fill > 0 && fill < 1 && 'is-part')}>
              <span className="cc-bar__fill" style={{ width: `${fill * 100}%` }} />
            </span>
          )
        })}
      </div>
    )
  }
  return (
    <div className={classes()} style={style} {...aria}>
      <span className="cc-bar__fill" style={{ width: `${clamp(max ? value / max : 0) * 100}%` }} />
    </div>
  )
}
