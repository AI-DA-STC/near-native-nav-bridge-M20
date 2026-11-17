import { useEffect, useRef } from 'react'
import { cx } from '@/shared/lib'
import type { TimelineRow } from '../../model/history'
import { LogTag } from './LogTag'
import './Timeline.css'

export interface TimelineProps {
  entries: TimelineRow[]
  /** Follows the newest row */
  autoScroll?: boolean
  emptyText?: string
  className?: string
}

/** The mission's history, newest at the bottom: time · TAG · text */
export function Timeline({ entries, autoScroll = true, emptyText = 'Nothing has happened yet.', className }: TimelineProps) {
  const listRef = useRef<HTMLOListElement>(null)
  useEffect(() => {
    if (autoScroll && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [entries.length, autoScroll])
  return (
    <ol className={cx('cc-timeline', className)} ref={listRef} aria-live="polite">
      {entries.length === 0 ? <li className="cc-timeline__empty">{emptyText}</li> : null}
      {entries.map((e) => (
        <li key={e.id} className={cx('cc-timeline__row', e.fresh && 'is-fresh')}>
          <time className="cc-timeline__time">{e.time}</time>
          <LogTag tag={e.tag} />
          <span className="cc-timeline__text">{e.text}</span>
        </li>
      ))}
    </ol>
  )
}
