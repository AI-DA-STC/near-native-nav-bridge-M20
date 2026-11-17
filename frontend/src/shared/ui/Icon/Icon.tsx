import type { CSSProperties, ReactElement } from 'react'
import { cx } from '@/shared/lib'

const STROKE = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

/** The system's 16 px line icons, drawn in currentColor */
const PATHS = {
  // step marks: pending ○ · active ▶ · done ✓ · failed ✕ · stopped ■ · skipped – · decision ◆
  pending: <circle cx="8" cy="8" r="5.2" {...STROKE} />,
  active: <path d="M5.4 3.6v8.8l6.9-4.4z" fill="currentColor" />,
  done: <path d="M3.3 8.5l3 3 6.4-6.8" {...STROKE} strokeWidth="2" />,
  failed: <path d="M4.3 4.3l7.4 7.4M11.7 4.3l-7.4 7.4" {...STROKE} strokeWidth="2" />,
  stopped: <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.2" fill="currentColor" />,
  skipped: <path d="M3.8 8h8.4" {...STROKE} strokeWidth="2" />,
  decision: <path d="M8 2.2l5.8 5.8L8 13.8 2.2 8z" fill="currentColor" />,
  // attention
  warn: (
    <>
      <path d="M8 2.1l6.4 11.2H1.6z" {...STROKE} strokeWidth="1.5" />
      <path d="M8 6.3v3.5" {...STROKE} />
      <circle cx="8" cy="11.5" r=".95" fill="currentColor" />
    </>
  ),
  fault: (
    <>
      <circle cx="8" cy="8" r="6.1" {...STROKE} strokeWidth="1.5" />
      <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" {...STROKE} />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="6.1" {...STROKE} strokeWidth="1.4" />
      <path d="M8 7.2v4" {...STROKE} />
      <circle cx="8" cy="4.9" r=".95" fill="currentColor" />
    </>
  ),
  // findings: the reticle ⌖ belongs to findings only
  finding: (
    <>
      <path d="M2.4 5.6V2.4h3.2M10.4 2.4h3.2v3.2M13.6 10.4v3.2h-3.2M5.6 13.6H2.4v-3.2" {...STROKE} />
      <circle cx="8" cy="8" r="1.9" fill="currentColor" />
    </>
  ),
  loop: (
    <>
      <path d="M3.6 8.6a4.6 4.6 0 1 0 1.5-4.1" {...STROKE} />
      <path d="M4.4 1.8v3h3" {...STROKE} />
    </>
  ),
  wait: (
    <>
      <circle cx="8" cy="8" r="6" {...STROKE} strokeWidth="1.4" />
      <path d="M8 4.8V8l2.2 1.6" {...STROKE} />
    </>
  ),
  // ui
  close: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" {...STROKE} />,
  expand: <path d="M9.6 2.6h3.8v3.8M6.4 13.4H2.6V9.6M13.4 2.6L9.2 6.8M2.6 13.4l4.2-4.2" {...STROKE} />,
  camera: (
    <>
      <rect x="1.8" y="4.4" width="12.4" height="8.8" rx="2" {...STROKE} />
      <circle cx="8" cy="8.8" r="2.3" {...STROKE} />
      <path d="M5.7 4.4l.9-1.8h2.8l.9 1.8" {...STROKE} />
    </>
  ),
  follow: (
    <>
      <circle cx="8" cy="8" r="4.4" {...STROKE} />
      <path d="M8 1.6v2.6M8 11.8v2.6M1.6 8h2.6M11.8 8h2.6" {...STROKE} />
    </>
  ),
  layers: (
    <>
      <path d="M8 2.6l5.8 3L8 8.6l-5.8-3z" {...STROKE} />
      <path d="M2.2 9.2L8 12.2l5.8-3" {...STROKE} />
    </>
  ),
  home: (
    <>
      <path d="M2.4 7.6L8 2.9l5.6 4.7" {...STROKE} />
      <path d="M4 6.6v6.6h8V6.6" {...STROKE} />
    </>
  ),
  trails: (
    <>
      <path d="M2 12.5c2.6 0 2.6-4.5 5.2-4.5S9.8 3.5 12.4 3.5" {...STROKE} strokeDasharray="1.4 2.2" />
      <circle cx="12.6" cy="3.6" r="1.6" fill="currentColor" />
    </>
  ),
  send: <path d="M2.6 8h10.2M9 4.3L12.8 8 9 11.7" {...STROKE} />,
  chevronLeft: <path d="M10 3.5L5.5 8l4.5 4.5" {...STROKE} />,
  chevronRight: <path d="M6 3.5L10.5 8 6 12.5" {...STROKE} />,
  chevronDown: <path d="M3.5 6l4.5 4.5L12.5 6" {...STROKE} />,
  play: <path d="M5.4 3.6v8.8l6.9-4.4z" fill="currentColor" />,
  pause: <path d="M5.5 3.8v8.4M10.5 3.8v8.4" {...STROKE} strokeWidth="2.2" />,
  stop: <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.2" fill="currentColor" />,
  battery: (
    <>
      <rect x="1.6" y="5" width="11.2" height="6" rx="1.4" {...STROKE} strokeWidth="1.4" />
      <path d="M14.4 7v2" {...STROKE} />
    </>
  ),
  link: (
    <>
      <path d="M2.3 6.4a8.2 8.2 0 0 1 11.4 0M4.4 8.8a5.2 5.2 0 0 1 7.2 0" {...STROKE} strokeWidth="1.5" />
      <circle cx="8" cy="11.6" r="1.1" fill="currentColor" />
    </>
  ),
  external: <path d="M6 3.4h6.6V10M12.4 3.6L4 12" {...STROKE} />,
  clock: (
    <>
      <circle cx="8" cy="8" r="6" {...STROKE} strokeWidth="1.4" />
      <path d="M8 4.8V8h2.6" {...STROKE} />
    </>
  ),
  eye: (
    <>
      <path d="M1.6 8s2.4-4.4 6.4-4.4S14.4 8 14.4 8s-2.4 4.4-6.4 4.4S1.6 8 1.6 8z" {...STROKE} strokeWidth="1.4" />
      <circle cx="8" cy="8" r="1.9" fill="currentColor" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" {...STROKE} />,
  minus: <path d="M3 8h10" {...STROKE} />,
  dot: <circle cx="8" cy="8" r="3" fill="currentColor" />,
} satisfies Record<string, ReactElement>

export type IconName = keyof typeof PATHS

export interface IconProps {
  name: IconName
  /** px, default 16 */
  size?: number
  /** Gives the icon an accessible name; without it the icon is hidden from assistive tech */
  title?: string
  className?: string
  style?: CSSProperties
}

export function Icon({ name, size = 16, title, className, style }: IconProps) {
  return (
    <svg
      className={cx('cc-icon', className)}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
      focusable="false"
      style={style}
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  )
}
