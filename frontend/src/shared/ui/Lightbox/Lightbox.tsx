import type { ReactNode } from 'react'
import { cx } from '@/shared/lib'
import { Button } from '@/shared/ui/Button'
import { DetectionImage, type DetectionBox } from '@/shared/ui/DetectionImage'
import { Scrim } from '@/shared/ui/Scrim'
import './Lightbox.css'

export interface LightboxProps {
  open?: boolean
  src?: string
  alt?: string
  boxes?: DetectionBox[]
  aspect?: string
  /** "ALOHA · contents photo · 10:44:44" */
  caption?: ReactNode
  /** Classes and the image path, in mono */
  meta?: ReactNode
  onClose?: () => void
  inline?: boolean
  className?: string
}

/** Any camera image enlarged, with its detections, a caption and the file name. Esc or Close. */
export function Lightbox({ open = true, src, alt, boxes = [], caption, meta, aspect = '4 / 3', onClose, inline = false, className }: LightboxProps) {
  if (!open) return null
  return (
    <Scrim dark inline={inline} onDismiss={onClose}>
      <figure
        className={cx('cc-lightbox', className)}
        role="dialog"
        aria-modal={inline ? undefined : true}
        aria-label={typeof caption === 'string' ? caption : alt}
      >
        <header className="cc-lightbox__head">
          <span className="cc-lightbox__cap">{caption}</span>
          <Button size="sm" icon="close" onClick={onClose} kbd="Esc" autoFocus={!inline}>
            Close
          </Button>
        </header>
        <DetectionImage src={src} alt={alt} boxes={boxes} aspect={aspect} />
        {meta ? <figcaption className="cc-lightbox__meta">{meta}</figcaption> : null}
      </figure>
    </Scrim>
  )
}
