import type { Box2, Pt } from '@/shared/api'

/* The map frame (metres, x right, y up) on screen (pixels, y down), with pan and zoom about the centre */

export interface Viewport {
  /** Zoom factor */
  k: number
  /** Pan, px */
  tx: number
  ty: number
}

export interface Size {
  w: number
  h: number
}

export interface Projection {
  /** px per metre at the current zoom */
  scale: number
  toScreen(x: number, y: number): Pt
  toMap(px: number, py: number): Pt
}

export const IDENTITY: Viewport = { k: 1, tx: 0, ty: 0 }
const MIN_ZOOM = 0.6
const MAX_ZOOM = 8
/** Following a robot zooms in at least this far */
const FOLLOW_ZOOM = 1.6

/** Fits `fit` into the box, inside the padding (more at the top and bottom for the toolbar and legend) */
function fitted(size: Size, fit: Box2, pad: { x: number; top: number; bottom: number }) {
  const s0 = Math.min((size.w - 2 * pad.x) / (fit.xMax - fit.xMin), (size.h - pad.top - pad.bottom) / (fit.yMax - fit.yMin))
  const ox = (size.w - s0 * (fit.xMax - fit.xMin)) / 2
  const oy = pad.top + (size.h - pad.top - pad.bottom - s0 * (fit.yMax - fit.yMin)) / 2
  const base = (x: number, y: number): Pt => [ox + (x - fit.xMin) * s0, oy + (fit.yMax - y) * s0]
  return { s0, ox, oy, base }
}

export function projectionOf(size: Size, fit: Box2, pad: { x: number; top: number; bottom: number }, vp: Viewport): Projection {
  const { s0, ox, oy, base } = fitted(size, fit, pad)
  const { k, tx, ty } = vp
  const cx = size.w / 2
  const cy = size.h / 2
  return {
    scale: s0 * k,
    toScreen(x, y) {
      const [bx, by] = base(x, y)
      return [cx + k * (bx - cx) + tx, cy + k * (by - cy) + ty]
    },
    toMap(px, py) {
      const bx = (px - cx - tx) / k + cx
      const by = (py - cy - ty) / k + cy
      return [(bx - ox) / s0 + fit.xMin, fit.yMax - (by - oy) / s0]
    },
  }
}

/** The viewport that keeps (x, y) in the middle, zoomed in at least to FOLLOW_ZOOM */
export function followViewport(size: Size, fit: Box2, pad: { x: number; top: number; bottom: number }, vp: Viewport, x: number, y: number): Viewport {
  const k = Math.max(vp.k, FOLLOW_ZOOM)
  const [bx, by] = fitted(size, fit, pad).base(x, y)
  return { k, tx: -k * (bx - size.w / 2), ty: -k * (by - size.h / 2) }
}

/** Zooms by `factor` about the pointer at (px, py), so the point under it stays put */
export function zoomAt(vp: Viewport, size: Size, px: number, py: number, factor: number): Viewport {
  const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, vp.k * factor))
  const f = k / vp.k
  const cx = size.w / 2
  const cy = size.h / 2
  return { k, tx: px - cx - f * (px - cx - vp.tx), ty: py - cy - f * (py - cy - vp.ty) }
}

/** The scale bar: the roundest length of metres that stays under 130 px */
export function scaleStep(pxPerMetre: number): number {
  for (const metres of [20, 10, 5, 2, 1, 0.5, 0.2]) if (metres * pxPerMetre <= 130) return metres
  return 0.1
}
