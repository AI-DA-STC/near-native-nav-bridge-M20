import { describe, expect, it } from 'vitest'
import { IDENTITY, projectionOf, scaleStep, zoomAt } from './map-projection'

const size = { w: 900, h: 560 }
const fit = { xMin: -5, xMax: 12, yMin: -12, yMax: 1 }
const pad = { x: 30, top: 58, bottom: 52 }

describe('map frame ↔ screen', () => {
  it('maps metres to pixels and back, at any pan and zoom', () => {
    for (const vp of [IDENTITY, { k: 2.4, tx: -130, ty: 85 }]) {
      const p = projectionOf(size, fit, pad, vp)
      const [px, py] = p.toScreen(4.05, -1.7)
      const [x, y] = p.toMap(px, py)
      expect(x).toBeCloseTo(4.05, 9)
      expect(y).toBeCloseTo(-1.7, 9)
    }
  })
  it('puts y up and x right', () => {
    const p = projectionOf(size, fit, pad, IDENTITY)
    const [ox, oy] = p.toScreen(0, 0)
    const [ax, ay] = p.toScreen(1, 1)
    expect(ax).toBeGreaterThan(ox)
    expect(ay).toBeLessThan(oy)
  })
  it('zooms about the pointer: the point under it stays put', () => {
    const before = projectionOf(size, fit, pad, IDENTITY)
    const under = before.toMap(600, 300)
    const after = projectionOf(size, fit, pad, zoomAt(IDENTITY, size, 600, 300, 1.15))
    const [px, py] = after.toScreen(under[0], under[1])
    expect(px).toBeCloseTo(600, 6)
    expect(py).toBeCloseTo(300, 6)
  })
  it('keeps the scale bar a round length under 130 px', () => {
    expect(scaleStep(40)).toBe(2)
    expect(scaleStep(10)).toBe(10)
    expect(scaleStep(400)).toBe(0.2)
  })
})
