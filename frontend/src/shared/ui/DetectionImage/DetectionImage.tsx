import type { ReactNode } from 'react'
import { cx, formatPercent } from '@/shared/lib'
import { Icon } from '@/shared/ui/Icon'
import './DetectionImage.css'

/** A detection on a frame, as fractions of the image (0–1) */
export interface DetectionBox {
  x: number
  y: number
  w: number
  h: number
  label?: string
  confidence?: number
  faint?: boolean
}

export interface DetectionImageProps {
  src?: string
  alt?: string
  boxes?: DetectionBox[]
  /** CSS aspect ratio, default 16 / 9 */
  aspect?: string
  /** Shows the enlarge button */
  onExpand?: () => void
  dim?: boolean
  className?: string
  /** Overlays such as the LIVE badge */
  children?: ReactNode
}

/** A camera frame as evidence, with every detection drawn on top in the finding colour, never baked in */
export function DetectionImage({ src, alt = '', boxes = [], aspect = '16 / 9', onExpand, dim = false, className, children }: DetectionImageProps) {
  return (
    <figure className={cx('cc-detimg', dim && 'is-dim', className)} style={{ aspectRatio: aspect }}>
      {src ? <img src={src} alt={alt} draggable={false} /> : <div className="cc-detimg__none" />}
      {boxes.map((b, i) => (
        <div
          key={i}
          className={cx('cc-detbox', b.faint && 'is-faint')}
          style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}
        >
          <i className="cc-detbox__c is-tl" />
          <i className="cc-detbox__c is-tr" />
          <i className="cc-detbox__c is-br" />
          <i className="cc-detbox__c is-bl" />
          {b.label ? (
            <span className={cx('cc-detbox__label', b.y < 0.12 && 'is-inside')}>
              {b.label}
              {b.confidence != null ? ` ${formatPercent(b.confidence)}` : ''}
            </span>
          ) : null}
        </div>
      ))}
      {children}
      {onExpand ? (
        <button type="button" className="cc-detimg__expand" onClick={onExpand} aria-label="Enlarge image">
          <Icon name="expand" size={14} />
        </button>
      ) : null}
    </figure>
  )
}
