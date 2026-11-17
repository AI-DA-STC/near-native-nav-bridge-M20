import { useId, useState, type CSSProperties, type ReactNode } from 'react'
import { cx } from '@/shared/lib'
import { Icon } from '@/shared/ui/Icon'
import './Panel.css'

export interface PanelProps {
  /** Set in capitals by the panel */
  title?: ReactNode
  /** The right side of the title row: a badge, a short note, a switch */
  meta?: ReactNode
  /** The operator's turn here: accent ring and a slow glow. One hot panel at a time. */
  hot?: boolean
  collapsible?: boolean
  collapsed?: boolean
  defaultCollapsed?: boolean
  onToggle?: (collapsed: boolean) => void
  /** The body scrolls inside (give the panel a height) */
  scroll?: boolean
  /** No body padding: maps, tables */
  flush?: boolean
  footer?: ReactNode
  className?: string
  style?: CSSProperties
  children?: ReactNode
}

/** The console's container: an uppercase title row with right-aligned meta over a body that scrolls inside */
export function Panel({
  title,
  meta,
  hot = false,
  collapsible = false,
  collapsed,
  defaultCollapsed = false,
  onToggle,
  scroll = false,
  flush = false,
  footer,
  className,
  style,
  children,
}: PanelProps) {
  const [open, setOpen] = useState(!defaultCollapsed)
  const isCollapsed = collapsed !== undefined ? collapsed : !open
  const titleId = useId()
  const toggle = () => {
    if (collapsed === undefined) setOpen(!open)
    onToggle?.(!isCollapsed)
  }
  const heading = (
    <h2 className="cc-panel__title" id={titleId}>
      {title}
    </h2>
  )
  return (
    <section
      className={cx(
        'cc-panel',
        hot && 'is-hot',
        isCollapsed && 'is-collapsed',
        scroll && 'cc-panel--scroll',
        flush && 'cc-panel--flush',
        className,
      )}
      style={style}
      aria-labelledby={title ? titleId : undefined}
    >
      {title || meta ? (
        <header className="cc-panel__head">
          {collapsible ? (
            <button type="button" className="cc-panel__toggle" aria-expanded={!isCollapsed} onClick={toggle}>
              <Icon name="chevronDown" size={14} className="cc-panel__chev" />
              {heading}
            </button>
          ) : (
            heading
          )}
          {meta ? <div className="cc-panel__meta">{meta}</div> : null}
        </header>
      ) : null}
      {!isCollapsed ? <div className="cc-panel__body">{children}</div> : null}
      {footer && !isCollapsed ? <footer className="cc-panel__foot">{footer}</footer> : null}
    </section>
  )
}
