import { useState } from 'react'
import type { SiteMapKind } from '@/shared/api'
import type { RobotKey } from '@/shared/config'
import type { MapLayers } from '../ui/mission-map/map-data'

/** How the operator looks at the map: which map (the dogs' or the ALOHA's own), and the robot selected. It changes
 * nothing on the robots. */
export function useMapView() {
  const [map, setMapState] = useState<SiteMapKind>('dogs')
  const [view, setView] = useState<'2d' | '3d'>('2d')
  const [follow, setFollow] = useState<RobotKey | null>(null)
  const [trails, setTrails] = useState(true)
  const [layers, setLayers] = useState<MapLayers>({})
  const [selected, setSelected] = useState<RobotKey | null>(null)
  const [resetKey, setResetKey] = useState(0)
  return {
    map,
    /** Another map starts from its whole extent, following nobody */
    setMap: (next: SiteMapKind) => {
      if (next === map) return
      setMapState(next)
      setResetKey((k) => k + 1)
      setFollow(null)
    },
    view,
    setView,
    follow,
    setFollow,
    trails,
    setTrails,
    layers,
    setLayers,
    selected,
    /** Selecting the selected robot again clears the selection */
    select: (robot: RobotKey) => setSelected((current) => (current === robot ? null : robot)),
    resetKey,
    /** Back to the whole site, following nobody */
    reset: () => {
      setResetKey((k) => k + 1)
      setFollow(null)
    },
  }
}

export type MapView = ReturnType<typeof useMapView>
