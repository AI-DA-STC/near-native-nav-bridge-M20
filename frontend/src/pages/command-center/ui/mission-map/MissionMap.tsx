import type { MissionSnapshot, SiteMap } from '@/shared/api'
import { ROBOT_KEYS } from '@/shared/config'
import { mapSceneOf } from '../../model/map-layers'
import type { MapView } from '../../model/map-view'
import { LiveMap } from './LiveMap'
import { MapLegend } from './MapLegend'
import { MapToolbar } from './MapToolbar'

/** The live map with its floating toolbar and legend */
export function MissionMap({ snap, site, view }: { snap: MissionSnapshot; site: SiteMap | null; view: MapView }) {
  if (!site) return <div className="cc-map" aria-busy="true" />
  const { legend, ...scene } = mapSceneOf(snap, site)
  return (
    <LiveMap
      {...scene}
      selected={view.selected}
      onRobotClick={view.select}
      view={view.view}
      follow={view.follow}
      trails={view.trails}
      layers={view.layers}
      resetKey={view.resetKey}
    >
      <MapToolbar
        follow={view.follow}
        robots={ROBOT_KEYS.filter((k) => snap.robots[k].inMission && (k !== 'aloha' || snap.robots.aloha.sameMap))}
        onFollow={view.setFollow}
        trails={view.trails}
        onTrails={view.setTrails}
        layers={view.layers}
        onLayers={view.setLayers}
        onReset={view.reset}
      />
      <MapLegend items={legend} />
    </LiveMap>
  )
}
