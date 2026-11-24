import { describe, expect, it } from 'vitest'
import { rowsOf } from './ping-panes'

describe('the panes’ rows', () => {
  it('at most three to a row, the fuller rows first', () => {
    const sizes = (n: number) => rowsOf(Array.from({ length: n }, (_, i) => i)).map((row) => row.length)
    expect([1, 2, 3, 4, 5, 6, 7].map(sizes)).toEqual([[1], [2], [3], [2, 2], [3, 2], [3, 3], [3, 2, 2]])
    expect(rowsOf(['a', 'b', 'c', 'd', 'e'])).toEqual([['a', 'b', 'c'], ['d', 'e']])
  })
})
