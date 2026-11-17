import { describe, expect, it } from 'vitest'
import { formatClock, formatDegrees, formatDuration, formatNumber, formatPercent } from './index'

describe('measures, as the console prints them', () => {
  it('uses a true minus sign and fixed decimals, and never prints −0.00', () => {
    expect(formatNumber(-1.7)).toBe('−1.70')
    expect(formatNumber(4.05)).toBe('4.05')
    expect(formatNumber(-0.001)).toBe('0.00')
    expect(formatNumber(null)).toBe('—')
    expect(formatNumber(2.94, 1)).toBe('2.9')
  })
  it('prints confidences as whole percents with a space, and headings in whole degrees', () => {
    expect(formatPercent(0.91)).toBe('91 %')
    expect(formatPercent(undefined)).toBe('—')
    expect(formatDegrees(-94.4)).toBe('−94°')
  })
  it('prints durations as m:ss and the mission clock as mm:ss', () => {
    expect(formatDuration(107_000)).toBe('1:47')
    expect(formatDuration(462_000)).toBe('7:42')
    expect(formatClock(246_000)).toBe('04:06')
    expect(formatClock(3_725_000)).toBe('1:02:05')
  })
})
