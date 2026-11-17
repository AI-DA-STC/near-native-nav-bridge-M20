import { useState } from 'react'
import type { RobotKey } from '@/shared/config'
import type { MapLayers } from '../ui/mission-map/map-data'

/** How the operator looks at the map, and the robot selected on both the map and the fleet cards. It changes nothing on
 * the robots. */
export function useMapView() {
  const [view, setView] = useState<'2d' | '3d'>('2d')
  const [follow, setFollow] = useState<RobotKey | null>(null)
  const [trails, setTrails] = useState(true)
  const [layers, setLayers] = useState<MapLayers>({})
  const [selected, setSelected] = useState<RobotKey | null>(null)
  const [resetKey, setResetKey] = useState(0)
  return {
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
