import type { MissionSnapshot } from '@/shared/api'
import { formatPercent, formatTimeOfDay, type Tone } from '@/shared/lib'
import type { DetectionBox } from '@/shared/ui/DetectionImage'
import type { IconName } from '@/shared/ui/Icon'

export interface CameraView {
  state: 'connecting' | 'live' | 'retrying' | 'failed'
  attempt: number
  of: number
  src: string | null
  detection: DetectionBox | null
  /** Live, nothing found yet */
  searching: boolean
}

export interface FindingView {
  snapshot: string
  detection: DetectionBox | null
  x: number
  y: number
  dist: number
  confidence: number
  /** Clock times; the first sighting stays the Found time */
  foundAt: string
  refinedAt: string | null
  refinements: number
}

export interface ContentsView {
  state: 'waiting' | 'capturing' | 'ready'
  src: string | null
  objects: Array<{ label: string; confidence: number; box: DetectionBox }>
  /** Seconds left of the 5 s hold */
  holdLeft: number | null
  takenAt: string | null
}

/** An image as the lightbox enlarges it */
export interface ImageView {
  src: string
  boxes: DetectionBox[]
  aspect: string
  caption: string
  meta: string
}

export interface SuspiciousItemView {
  /** What the panel shows: R3's camera, then BOX FOUND, then the ALOHA's photo of the contents */
  stage: 'camera' | 'finding' | 'contents'
  status: { tone: Tone; icon: IconName; text: string }
  camera: CameraView
  finding: FindingView | null
  contents: ContentsView | null
  images: { camera: ImageView | null; finding: ImageView | null; contents: ImageView | null }
}

/** The contents photo, while the Operator panel does not show it for the verdict */
export function contentsOf(snap: MissionSnapshot): ContentsView | null {
  const { contents } = snap
  const { holdEndsAt } = snap.robots.aloha.arms
  if (contents.state === 'failed') return null
  return {
    state: contents.state === 'ready' ? 'ready' : contents.state,
    src: contents.photo?.url ?? null,
    objects: contents.objects.map((o) => ({ label: o.label, confidence: o.confidence, box: o.box ?? { x: 0, y: 0, w: 0, h: 0 } })),
    holdLeft: holdEndsAt === null ? null : Math.max(0, Math.ceil((holdEndsAt - snap.serverTime) / 1000)),
    takenAt: contents.photo ? formatTimeOfDay(contents.photo.at) : null,
  }
}

export function contentsImageOf(snap: MissionSnapshot): ImageView | null {
  const { photo, objects } = snap.contents
  if (!photo) return null
  return {
    src: photo.url,
    boxes: objects.flatMap((o) => (o.box ? [{ ...o.box, label: o.label, confidence: o.confidence }] : [])),
    aspect: '4 / 3',
    caption: `ALOHA · contents photo · ${formatTimeOfDay(photo.at)}`,
    meta: [objects.map((o) => `${o.label} ${formatPercent(o.confidence)}`).join(', '), photo.path].filter(Boolean).join(' · '),
  }
}

/** `contentsInOperator`: the Operator panel shows the photo for the verdict, so this panel shows the finding instead */
export function suspiciousItemOf(snap: MissionSnapshot, contentsInOperator: boolean): SuspiciousItemView {
  const { camera: cam, detection } = snap
  const box = cam.box ? { ...cam.box, label: 'box', confidence: cam.box.confidence } : null
  const camera: CameraView = {
    state: cam.state === 'gave-up' ? 'failed' : cam.state,
    attempt: cam.attempt,
    of: cam.of,
    src: cam.frame?.url ?? null,
    detection: box,
    searching: cam.searching && !box,
  }
  const finding: FindingView | null = detection && {
    snapshot: detection.snapshot.url,
    detection: detection.snapshot.box ? { ...detection.snapshot.box, label: 'box', confidence: detection.confidence } : null,
    x: detection.x,
    y: detection.y,
    dist: detection.distM,
    confidence: detection.confidence,
    foundAt: formatTimeOfDay(detection.foundAt),
    refinedAt: detection.refinedAt === null ? null : formatTimeOfDay(detection.refinedAt),
    refinements: detection.refinements,
  }
  const contents = contentsOf(snap)
  const stage = contents && contents.state !== 'waiting' && !contentsInOperator ? 'contents' : finding ? 'finding' : 'camera'
  const status: SuspiciousItemView['status'] =
    cam.state === 'live'
      ? { tone: 'live', icon: 'camera', text: 'R3 camera live' }
      : cam.state === 'retrying'
        ? { tone: 'warn', icon: 'warn', text: `No video · retrying ${cam.attempt}/${cam.of}` }
        : cam.state === 'gave-up'
          ? { tone: 'warn', icon: 'warn', text: 'No video from R3' }
          : { tone: 'neutral', icon: 'camera', text: 'R3 camera connecting' }
  return {
    stage,
    status,
    camera,
    finding,
    contents,
    images: {
      camera: cam.frame
        ? { src: cam.frame.url, boxes: box ? [box] : [], aspect: '16 / 9', caption: `R3 · front camera · ${formatTimeOfDay(cam.frame.at)}`, meta: 'live frame' }
        : null,
      finding:
        detection && finding
          ? {
              src: detection.snapshot.url,
              boxes: finding.detection ? [finding.detection] : [],
              aspect: '16 / 9',
              caption: `R3 · BOX FOUND · ${finding.refinedAt ?? finding.foundAt}`,
              meta: [`box ${formatPercent(detection.confidence)}`, detection.snapshot.path].filter(Boolean).join(' · '),
            }
          : null,
      contents: contentsImageOf(snap),
    },
  }
}
