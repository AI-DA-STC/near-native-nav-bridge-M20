/** The phase track's grid columns, shared with the task lanes so both line up: a head column, then one column per
 * phase. The active phase takes 2.7 shares, a failed one 2.1, the two decisions 1.08, every other phase 1. */
export function phaseColumns(phases: ReadonlyArray<{ status: string; decision: boolean }>, head = 76): string {
  const shares = phases.map((p) => (p.status === 'active' ? 2.7 : p.status === 'failed' ? 2.1 : p.decision ? 1.08 : 1))
  return [head ? `${head}px` : '', ...shares.map((share) => `minmax(0, ${share}fr)`)].filter(Boolean).join(' ')
}
