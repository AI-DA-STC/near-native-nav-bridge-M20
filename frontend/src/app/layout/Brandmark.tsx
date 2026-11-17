import { cx } from '@/shared/lib'
import './Brandmark.css'

const CHEVRON = 'M3.3 0L-2.5 2.9L-1.05 0L-2.5 -2.9Z'

export interface BrandmarkProps {
  /** px, 28–30 in the header */
  size?: number
  /** Turns the satellites while a mission runs, waits for the operator or stops; still otherwise */
  running?: boolean
  title?: string
  className?: string
}

/** An accent hub with three dog chevrons and the ALOHA's square on one orbit */
export function Brandmark({ size = 28, running = false, title = 'Command Center', className }: BrandmarkProps) {
  return (
    <svg className={cx('cc-brandmark', running && 'is-running', className)} width={size} height={size} viewBox="0 0 32 32" role="img" aria-label={title}>
      <circle className="cc-brandmark__orbit" cx="16" cy="16" r="11.6" />
      <g className="cc-brandmark__sats">
        <path className="cc-brandmark__sat" d={CHEVRON} transform="translate(16 4.4)" />
        <path className="cc-brandmark__sat" d={CHEVRON} transform="translate(27.6 16) rotate(90)" />
        <path className="cc-brandmark__sat" d={CHEVRON} transform="translate(4.4 16) rotate(-90)" />
        <rect className="cc-brandmark__sat" x="13.8" y="25.4" width="4.4" height="4.4" rx="1" />
      </g>
      <circle className="cc-brandmark__ring" cx="16" cy="16" r="6.3" />
      <circle className="cc-brandmark__hub" cx="16" cy="16" r="4.1" />
    </svg>
  )
}
