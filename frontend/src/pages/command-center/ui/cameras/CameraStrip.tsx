import type { RobotKey } from '@/shared/config'
import { cx } from '@/shared/lib'
import { Panel } from '@/shared/ui/Panel'
import { RobotTag } from '@/shared/ui/RobotTag'
import type { CameraTileView } from '../../model/camera-feeds'
import './CameraStrip.css'

export interface CameraStripProps {
  tiles: CameraTileView[]
  /** Minimized to its title row: the operator's choice */
  minimized: boolean
  onMinimize: (minimized: boolean) => void
  /** A feed enlarged in the lightbox, which follows it */
  onExpand: (robot: RobotKey) => void
  /** 1280×720: shorter feeds */
  compact?: boolean
}

/** The robots' cameras side by side over the map, one frame a second: each dog's front camera and the ALOHA's centre
 * camera, each with its robot's state word. A feed that stopped, or never came, says what to check. */
export function CameraStrip({ tiles, minimized, onMinimize, onExpand, compact = false }: CameraStripProps) {
  if (!tiles.length) return null
  const live = tiles.filter((t) => t.state === 'live').length
  return (
    <Panel
      title="Cameras"
      meta={
        <span className="cc-camstrip__meta">
          {live}/{tiles.length} live · 1 FPS
        </span>
      }
      collapsible
      collapsed={minimized}
      onToggle={onMinimize}
      flush
      className={cx('cc-camstrip', compact && 'is-compact')}
    >
      <div className="cc-camstrip__row">
        {tiles.map((t) => (
          <button
            key={t.robot}
            type="button"
            className={cx('cc-camtile', `is-${t.state}`)}
            disabled={!t.src}
            onClick={() => onExpand(t.robot)}
            title={t.src ? `${t.name} · ${t.camera}: enlarge` : (t.note ?? undefined)}
          >
            {t.src ? <img className="cc-camtile__img" src={t.src} alt={`${t.name} ${t.camera}`} /> : null}
            <span className="cc-camtile__top">
              <RobotTag robot={t.robot} size="sm" />
              <span className={cx('cc-camtile__word', `cc-tone--${t.tone}`)}>{t.word}</span>
            </span>
            {t.note ? <span className={cx('cc-camtile__note', t.state === 'stale' && 'is-stale')}>{t.note}</span> : null}
          </button>
        ))}
      </div>
    </Panel>
  )
}
