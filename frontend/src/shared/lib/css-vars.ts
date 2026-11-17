import type { CSSProperties } from 'react'

/** Inline custom properties (`--rc`, `--tc`, …) as a style object, merged with any other style */
export function cssVars(vars: Record<`--${string}`, string | number | undefined>, style?: CSSProperties): CSSProperties {
  return { ...vars, ...style } as CSSProperties
}
