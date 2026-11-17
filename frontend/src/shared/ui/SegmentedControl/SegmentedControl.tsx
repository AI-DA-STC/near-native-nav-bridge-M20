import type { ReactNode } from 'react'
import { cx } from '@/shared/lib'
import { Icon, type IconName } from '@/shared/ui/Icon'
import './SegmentedControl.css'

export interface SegmentedOption<V extends string> {
  value: V
  label: ReactNode
  icon?: IconName
  title?: string
}

export interface SegmentedControlProps<V extends string> {
  /** Two to four views, one short word each */
  options: ReadonlyArray<V | SegmentedOption<V>>
  value: V
  onChange?: (value: V) => void
  /** sm: floating toolbars · md */
  size?: 'sm' | 'md'
  /** Accessible group name */
  label?: string
  className?: string
}

/** Mutually exclusive views in one control; the chosen one takes the accent */
export function SegmentedControl<V extends string>({ options, value, onChange, size = 'sm', label, className }: SegmentedControlProps<V>) {
  return (
    <div className={cx('cc-seg', `cc-seg--${size}`, className)} role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const opt: SegmentedOption<V> = typeof option === 'string' ? { value: option, label: option } : option
        const on = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={on}
            className={cx('cc-seg__opt', on && 'is-on')}
            onClick={() => onChange?.(opt.value)}
            title={opt.title}
          >
            {opt.icon ? <Icon name={opt.icon} size={14} /> : null}
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
