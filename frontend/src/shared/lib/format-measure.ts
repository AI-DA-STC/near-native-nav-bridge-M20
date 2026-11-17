const MINUS = '−'
const MISSING = '—'

/** A map-frame number with fixed decimals and a true minus sign: 4.05, −1.70. Missing prints "—"; −0.00 prints 0.00. */
export function formatNumber(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return MISSING
  const digits = Math.abs(n).toFixed(decimals)
  return (n < 0 && Number(digits) !== 0 ? MINUS : '') + digits
}

/** A confidence (0–1) as a whole percent with a space: "91 %". Missing prints "—". */
export function formatPercent(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || Number.isNaN(fraction)) return MISSING
  return `${Math.round(fraction * 100)} %`
}

/** A heading in whole degrees with a true minus sign: "−94°". */
export function formatDegrees(degrees: number): string {
  return `${formatNumber(Math.round(degrees), 0)}°`
}
