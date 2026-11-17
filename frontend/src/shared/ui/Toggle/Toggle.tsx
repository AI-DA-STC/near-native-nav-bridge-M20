import type { ReactNode } from 'react'
import { cx } from '@/shared/lib'
import { Icon } from '@/shared/ui/Icon'
import './Toggle.css'

export interface ToggleProps {
  checked?: boolean
  onChange?: (checked: boolean) => void
  label?: ReactNode
  disabled?: boolean
  className?: string
}

/** A labelled checkbox for a view option that changes nothing on the robots */
export function Toggle({ checked = false, onChange, label, disabled, className }: ToggleProps) {
  return (
    <label className={cx('cc-toggle', disabled && 'is-disabled', className)}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange?.(e.target.checked)} />
      <span className="cc-toggle__box" aria-hidden="true">
        <Icon name="done" size={12} />
      </span>
      {label ? <span className="cc-toggle__label">{label}</span> : null}
    </label>
  )
}
