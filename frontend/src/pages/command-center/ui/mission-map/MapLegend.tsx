import type { RobotKey } from '@/shared/config'
import { cssVars, cx } from '@/shared/lib'
import { RobotGlyph } from '@/shared/ui/RobotGlyph'
import type { LegendItem, LegendKind } from './map-data'
import './MapLegend.css'

/** A neutral swatch stands for "this shape, in the robot's colour" */
function Swatch({ kind, color }: { kind: LegendKind; color?: RobotKey }) {
  const style = cssVars({ '--rc': color ? `var(--robot-${color})` : 'var(--text-2)' })
  switch (kind) {
    case 'robot':
      return <RobotGlyph robot={color ?? 'r1'} size={14} />
    case 'aloha':
      return <RobotGlyph robot="aloha" size={14} />
    case 'sweep':
      return (
        <svg className="cc-sw" width="18" height="12" style={style}>
          <line x1="1" y1="6" x2="17" y2="6" className="cc-sw__line" />
        </svg>
      )
    case 'patrol':
      return (
        <svg className="cc-sw" width="18" height="12" style={style}>
          <line x1="1" y1="6" x2="17" y2="6" className="cc-sw__line is-dash" />
        </svg>
      )
    case 'waypoint':
      return (
        <svg className="cc-sw" width="14" height="14" style={style}>
          <circle cx="7" cy="7" r="5.6" className="cc-sw__wp" />
          <text x="7" y="9.6">
            2
          </text>
        </svg>
      )
    case 'target':
      return (
        <svg className="cc-sw" width="14" height="14" style={style}>
          <circle cx="7" cy="7" r="5.6" className="cc-sw__target" />
        </svg>
      )
    case 'slot':
      return (
        <svg className="cc-sw" width="14" height="14" style={style}>
          <rect x="1.5" y="1.5" width="11" height="11" rx="2.5" className="cc-sw__slot" />
        </svg>
      )
    case 'cordon':
      return (
        <svg className="cc-sw" width="14" height="14" style={style}>
          <path d="M7 1.4L12.6 7 7 12.6 1.4 7z" className="cc-sw__slot" />
        </svg>
      )
    case 'box':
      return (
        <svg className="cc-sw" width="16" height="14">
          <circle cx="8" cy="7" r="6.2" className="cc-sw__halo" />
          <rect x="4.5" y="5" width="7" height="4.4" rx="1" className="cc-sw__box" />
        </svg>
      )
    case 'sight':
      return (
        <svg className="cc-sw" width="18" height="12" style={style}>
          <line x1="1" y1="6" x2="17" y2="6" className="cc-sw__line is-sight" />
        </svg>
      )
    case 'dock':
      return (
        <svg className="cc-sw" width="16" height="12">
          <rect x="1.5" y="2" width="11" height="8" rx="2" className="cc-sw__dock" />
        </svg>
      )
  }
}

/** The translucent legend chip at the bottom left of the map: one swatch per thing drawn */
export function MapLegend({ items, className }: { items: LegendItem[]; className?: string }) {
  if (items.length === 0) return null
  return (
    <div className={cx('cc-legend', className)} aria-label="Map legend">
      {items.map((item) => (
        <span key={`${item.kind}-${item.color ?? ''}`} className="cc-legend__item">
          <Swatch kind={item.kind} color={item.color} />
          <span>{item.label}</span>
        </span>
      ))}
    </div>
  )
}
