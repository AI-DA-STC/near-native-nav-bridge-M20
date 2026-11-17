import type { LogTag as Tag } from '@/shared/api'
import { cssVars, cx } from '@/shared/lib'
import './LogTag.css'

const TAG_TONE: Record<Tag, string> = {
  // the operator's own actions
  OPERATOR: 'var(--accent)',
  PLAN: 'var(--text-2)',
  FLEET: 'var(--live)',
  R1: 'var(--robot-r1)',
  R2: 'var(--robot-r2)',
  R3: 'var(--robot-r3)',
  ALOHA: 'var(--robot-aloha)',
  DETECT: 'var(--finding)',
  INSPECT: 'var(--finding)',
  WARN: 'var(--warn-text)',
  FAULT: 'var(--fault-text)',
  ESTOP: 'var(--fault-text)',
}

/** The TAG column of the timeline */
export function LogTag({ tag, className }: { tag: Tag; className?: string }) {
  return (
    <span className={cx('cc-logtag', className)} style={cssVars({ '--tc': TAG_TONE[tag] })}>
      {tag}
    </span>
  )
}
