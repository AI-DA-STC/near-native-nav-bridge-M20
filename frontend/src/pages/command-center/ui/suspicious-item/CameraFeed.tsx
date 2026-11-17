import { robotOf, type RobotKey } from '@/shared/config'
import { cx } from '@/shared/lib'
import { DetectionImage } from '@/shared/ui/DetectionImage'
import { Icon } from '@/shared/ui/Icon'
import { RobotTag } from '@/shared/ui/RobotTag'
import { StatusDot } from '@/shared/ui/StatusDot'
import type { CameraView } from '../../model/suspicious-item'
import './CameraFeed.css'

export interface CameraFeedProps {
  camera: CameraView
  robot?: RobotKey
  onExpand?: () => void
  label?: string
  className?: string
}

/** R3's front camera: connecting, live with the detection drawn, or no video and retrying n/3 (a warning, never a
 * failure in red) */
export function CameraFeed({ camera, robot = 'r3', onExpand, label = 'front camera', className }: CameraFeedProps) {
  const r = robotOf(robot)
  const who = (
    <span className="cc-cam__who">
      <RobotTag robot={robot} size="sm" /> {label}
    </span>
  )
  return (
    <div className={cx('cc-cam', `is-${camera.state}`, className)}>
      {camera.state === 'live' ? (
        <DetectionImage src={camera.src ?? undefined} alt={`${r.label} ${label}`} boxes={camera.detection ? [camera.detection] : []} onExpand={onExpand}>
          <span className="cc-cam__live">
            <StatusDot tone="live" pulse size={6} className="cc-cam__rec" />
            LIVE
          </span>
          {who}
          {camera.searching ? <span className="cc-cam__search">searching for the box…</span> : null}
        </DetectionImage>
      ) : (
        <div className="cc-cam__empty" style={{ aspectRatio: '16 / 9' }}>
          {who}
          {camera.state === 'connecting' ? (
            <div className="cc-cam__msg">
              <span className="cc-spinner" aria-hidden="true" />
              <span>Connecting to {r.label}'s camera…</span>
            </div>
          ) : camera.state === 'retrying' ? (
            <div className="cc-cam__msg is-warn">
              <Icon name="warn" size={18} />
              <span>
                No video from {r.label}, retrying {camera.attempt}/{camera.of}
              </span>
              <span className="cc-cam__tries" aria-hidden="true">
                {Array.from({ length: camera.of }, (_, i) => (
                  <i key={i} className={i < camera.attempt - 1 ? 'is-used' : i === camera.attempt - 1 ? 'is-now' : ''} />
                ))}
              </span>
            </div>
          ) : (
            <div className="cc-cam__msg is-warn">
              <Icon name="warn" size={18} />
              <span>
                No video from {r.label} after {camera.of} tries
              </span>
              <span className="cc-cam__sub">The detector gave up; the sweep ends early. A warning, not a failure.</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
