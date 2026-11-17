import { useState } from 'react'
import { ROBOT_KEYS, robotOf, type RobotKey } from '@/shared/config'
import { cx } from '@/shared/lib'
import { Button } from '@/shared/ui/Button'
import { RobotTag } from '@/shared/ui/RobotTag'
import { SegmentedControl } from '@/shared/ui/SegmentedControl'
import { Toggle } from '@/shared/ui/Toggle'
import type { MapLayerKey, MapLayers } from './map-data'
import './MapToolbar.css'

const MAP_LAYERS: ReadonlyArray<{ key: MapLayerKey; label: string }> = [
  { key: 'grid', label: 'Occupancy grid' },
  { key: 'zones', label: 'Zones' },
  { key: 'routes', label: 'Routes and waypoints' },
  { key: 'sight', label: 'Sight line' },
  { key: 'labels', label: 'Labels' },
]

export interface MapToolbarProps {
  view: '2d' | '3d'
  onView: (view: '2d' | '3d') => void
  follow: RobotKey | null
  /** null for a free view */
  onFollow: (robot: RobotKey | null) => void
  robots?: readonly RobotKey[]
  onReset: () => void
  trails: boolean
  onTrails: (on: boolean) => void
  layers: MapLayers
  onLayers: (layers: MapLayers) => void
  className?: string
}

/** The floating bar over the map: it changes the view only, never the robots */
export function MapToolbar({ view, onView, follow, onFollow, robots = ROBOT_KEYS, onReset, trails, onTrails, layers, onLayers, className }: MapToolbarProps) {
  const [open, setOpen] = useState<'follow' | 'layers' | null>(null)
  const flip = (menu: 'follow' | 'layers') => setOpen(open === menu ? null : menu)
  return (
    <div className={cx('cc-maptool', className)} role="toolbar" aria-label="Map tools">
      <SegmentedControl options={[{ value: '2d', label: '2D' }, { value: '3d', label: '3D' }]} value={view} onChange={onView} label="Map view" />
      <span className="cc-maptool__sep" />
      <div className="cc-maptool__menu">
        <Button size="sm" icon="follow" iconRight="chevronDown" pressed={follow !== null} aria-expanded={open === 'follow'} onClick={() => flip('follow')}>
          {follow ? `Following ${robotOf(follow).label}` : 'Follow robot'}
        </Button>
        {open === 'follow' ? (
          <div className="cc-menu" role="menu">
            {[null, ...robots].map((key) => (
              <button
                key={key ?? 'none'}
                type="button"
                role="menuitemradio"
                aria-checked={follow === key}
                className={cx('cc-menu__item', follow === key && 'is-on')}
                onClick={() => {
                  onFollow(key)
                  setOpen(null)
                }}
              >
                {key ? <RobotTag robot={key} swatch="glyph" /> : <span className="cc-menu__none">Free view</span>}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <Button size="sm" icon="home" onClick={onReset}>
        Reset view
      </Button>
      <Toggle checked={trails} onChange={onTrails} label="Trails" />
      <div className="cc-maptool__menu">
        <Button size="sm" icon="layers" iconRight="chevronDown" aria-expanded={open === 'layers'} onClick={() => flip('layers')}>
          Layers
        </Button>
        {open === 'layers' ? (
          <div className="cc-menu cc-menu--checks" role="menu">
            {MAP_LAYERS.map((layer) => (
              <Toggle key={layer.key} checked={layers[layer.key] !== false} label={layer.label} onChange={(on) => onLayers({ ...layers, [layer.key]: on })} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}
