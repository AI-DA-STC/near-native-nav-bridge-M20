import type { ReactNode } from 'react'
import { cx } from '@/shared/lib'
import './Tabs.css'

export interface TabItem {
  id: string
  label: ReactNode
  /** Something to look at there, such as a failing health check */
  count?: number
  disabled?: boolean
  /** Why the tab is disabled, as its tooltip */
  title?: string
}

export interface TabsProps {
  items: TabItem[]
  value?: string
  onChange?: (id: string) => void
  className?: string
}

/** The screen tabs under the header; the selected one sits on surface-raised-2 with an accent underline */
export function Tabs({ items, value, onChange, className }: TabsProps) {
  return (
    <div className={cx('cc-tabs', className)} role="tablist">
      {items.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === value}
          className={cx('cc-tab', tab.id === value && 'is-active')}
          disabled={tab.disabled}
          title={tab.title}
          onClick={() => onChange?.(tab.id)}
        >
          <span>{tab.label}</span>
          {tab.count ? <span className="cc-tab__count">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  )
}
