import { useState } from 'react'

/* Whether a section of the Command center is minimized (the phase track, the cameras): the operator's choice, kept in
 * this browser between visits. Without storage (a private window) it starts expanded and is kept for the visit only. */

function read(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

export function useMinimized(key: string): [boolean, (minimized: boolean) => void] {
  const [minimized, setMinimized] = useState(() => read(key))
  const set = (value: boolean) => {
    setMinimized(value)
    try {
      localStorage.setItem(key, value ? '1' : '0')
    } catch {
      // kept for this visit only
    }
  }
  return [minimized, set]
}
