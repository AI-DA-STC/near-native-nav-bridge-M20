import { useEffect } from 'react'
import { isReplaySource, missionSource, useMissionSnapshot } from '@/shared/api'
import { cx } from '@/shared/lib'
import { Icon } from '@/shared/ui/Icon'
import { Kbd } from '@/shared/ui/Kbd'
import './ScenarioSwitcher.css'

/** PROTOTYPE ONLY: steps through the brief's states of the scenario replay. It never shows with a live source. */
export function ScenarioSwitcher() {
  useMissionSnapshot()
  const source = missionSource()
  if (!isReplaySource(source)) return null
  return <ProtoSwitcher states={source.states} index={source.index()} onChange={source.go} />
}

export interface ProtoSwitcherProps {
  states: ReadonlyArray<{ n?: number; label: string; star?: boolean }>
  index: number
  onChange?: (index: number) => void
  /** ← / → anywhere, except while typing or with a dialog open */
  keys?: boolean
  inline?: boolean
  className?: string
}

/** The floating pill at the bottom left, deliberately outside the product's look */
export function ProtoSwitcher({ states, index, onChange, keys = true, inline = false, className }: ProtoSwitcherProps) {
  const n = states.length
  const go = (step: number) => {
    if (n) onChange?.((index + step + n) % n)
  }
  useEffect(() => {
    if (!keys) return undefined
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (document.querySelector('[aria-modal="true"]')) return
      if (e.key === 'ArrowLeft') go(-1)
      if (e.key === 'ArrowRight') go(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const state = states[index]
  return (
    <div className={cx('cc-proto', inline && 'is-inline', className)} role="group" aria-label="Prototype state switcher, prototype only">
      <span className="cc-proto__tag">PROTOTYPE</span>
      <button type="button" className="cc-proto__btn" onClick={() => go(-1)} aria-label="Previous state">
        <Icon name="chevronLeft" size={14} />
      </button>
      <span className="cc-proto__state">
        <span className="cc-proto__n cc-mono">
          {state?.n ?? index + 1}/{n}
        </span>
        {state?.star ? (
          <span className="cc-proto__star" title="This round">
            ★
          </span>
        ) : null}
        <span className="cc-proto__label">{state?.label}</span>
      </span>
      <button type="button" className="cc-proto__btn" onClick={() => go(1)} aria-label="Next state">
        <Icon name="chevronRight" size={14} />
      </button>
      <span className="cc-proto__keys">
        <Kbd>←</Kbd>
        <Kbd>→</Kbd>
      </span>
    </div>
  )
}
