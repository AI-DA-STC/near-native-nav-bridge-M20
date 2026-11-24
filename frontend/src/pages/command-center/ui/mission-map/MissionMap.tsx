import type { MapReadFacts, MissionSnapshot, SiteMap } from '@/shared/api'
import { ROBOT_KEYS } from '@/shared/config'
import { alohaSceneOf, mapSceneOf } from '../../model/map-layers'
import type { MapView } from '../../model/map-view'
import { LiveMap } from './LiveMap'
import { MapLegend } from './MapLegend'
import { MapToolbar } from './MapToolbar'

/** Over the ALOHA's tab while it has no map: what the server is doing about it */
function alohaMapNote(facts: MapReadFacts | undefined): string {
  if (!facts) return 'No map from the ALOHA yet'
  switch (facts.state) {
    case 'reading':
      return 'Reading the ALOHA’s map (/map through its bridge)…'
    case 'failed':
      return `No map from the ALOHA: ${facts.reason ?? 'none came'}. Trying again every 30 s.`
    case 'ready':
      return 'Loading the ALOHA’s map…'
    case 'waiting':
      return facts.reason ? `No map from the ALOHA yet: ${facts.reason}` : 'No map from the ALOHA yet'
  }
}

export interface MissionMapProps {
  snap: MissionSnapshot
  /** The dogs' map */
  site: SiteMap | null
  /** The ALOHA's own map: the two are not aligned, so each has its tab */
  alohaSite: SiteMap | null
  view: MapView
}

/** The live map with its floating toolbar and legend: the dogs' map, or, in its own tab, the ALOHA's */
export function MissionMap({ snap, site, alohaSite, view }: MissionMapProps) {
  const alohaIn = snap.robots.aloha.inMission
  const onAloha = alohaIn && view.map === 'aloha'
  const shown = onAloha ? alohaSite : site
  if (!shown) return <div className="cc-map" aria-busy="true" />
  const { legend, ...scene } = onAloha ? alohaSceneOf(snap, shown) : mapSceneOf(snap, shown)
  const robots = onAloha ? (['aloha'] as const) : ROBOT_KEYS.filter((k) => snap.robots[k].inMission && (k !== 'aloha' || snap.robots.aloha.sameMap))
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
        map={alohaIn ? (onAloha ? 'aloha' : 'dogs') : undefined}
        onMap={view.setMap}
        follow={view.follow}
        robots={robots}
        onFollow={view.setFollow}
        trails={view.trails}
        onTrails={view.setTrails}
        layers={view.layers}
        onLayers={view.setLayers}
        onReset={view.reset}
      />
      {onAloha && !shown.occupancy ? <p className="cc-map__note">{alohaMapNote(snap.alohaMap)}</p> : null}
      <MapLegend items={legend} />
    </LiveMap>
  )
}
