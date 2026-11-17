import { useSyncExternalStore, type ReactNode } from 'react'

export type ToastTone = 'neutral' | 'ok' | 'warn' | 'fault' | 'finding' | 'accent'

export interface ToastMessage {
  id: number
  tone: ToastTone
  title: ReactNode
  body?: ReactNode
}

/** How long a toast stays: long enough to read a line, short enough not to pile up */
const TOAST_MS = 4000

let toasts: readonly ToastMessage[] = []
let nextId = 1
const listeners = new Set<() => void>()

function publish(next: readonly ToastMessage[]) {
  toasts = next
  listeners.forEach((listener) => listener())
}

/** Confirms that something happened (instruction sent, plan approved, verdict saved), bottom right, for a few seconds.
 * Never for what needs the operator: that is a hot panel. */
export function pushToast(toast: Omit<ToastMessage, 'id' | 'tone'> & { tone?: ToastTone }): number {
  const id = nextId++
  publish([...toasts, { tone: 'neutral', ...toast, id }])
  setTimeout(() => dismissToast(id), TOAST_MS)
  return id
}

export function dismissToast(id: number): void {
  if (toasts.some((t) => t.id === id)) publish(toasts.filter((t) => t.id !== id))
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The toasts on screen, oldest first */
export function useToasts(): readonly ToastMessage[] {
  return useSyncExternalStore(subscribe, () => toasts, () => toasts)
}
