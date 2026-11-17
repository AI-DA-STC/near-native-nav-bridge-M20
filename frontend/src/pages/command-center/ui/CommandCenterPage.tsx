import { useState, type ReactNode } from 'react'
import { useMissionSnapshot } from '@/shared/api'
import { cx, useCompactLayout } from '@/shared/lib'
import { Lightbox } from '@/shared/ui/Lightbox'
import { useSiteMap } from '../api/fetch-site-map'
import { useMapView } from '../model/map-view'
import { operatorTurnOf } from '../model/operator-turn'
import { phaseTrackOf } from '../model/phase-track'
import type { ImageView } from '../model/suspicious-item'
import { taskLanesOf } from '../model/task-lanes'
import { FleetColumn } from './fleet/FleetColumn'
import { HistoryPanel } from './history/HistoryPanel'
import { MissionMap } from './mission-map/MissionMap'
import { OperatorPanel } from './operator/OperatorPanel'
import { PhaseTrack } from './phase-track/PhaseTrack'
import { SuspiciousItemPanel } from './suspicious-item/SuspiciousItemPanel'
import './CommandCenterPage.css'

export interface CommandCenterPageProps {
  /** Start mission: the app owns the command and hands its button to the Operator panel before the start */
  startControl?: ReactNode
}

/** The one screen that runs the whole mission. When space is tight these survive in order: where the mission is and
 * what comes next, whether it is the operator's turn, where each robot is, what has been found, what is wrong, history. */
export function CommandCenterPage({ startControl }: CommandCenterPageProps) {
  const snap = useMissionSnapshot()
  const site = useSiteMap()
  const compact = useCompactLayout()
  const mapView = useMapView()
  const [lightbox, setLightbox] = useState<ImageView | null>(null)
  if (!snap) return null
  const track = phaseTrackOf(snap)
  const turn = operatorTurnOf(snap)
  return (
    <div className={cx('cc-ccpage', compact && 'is-compact')}>
      <PhaseTrack
        phases={track.phases}
        loops={track.loops}
        lanes={taskLanesOf(snap)}
        lanesMode={compact ? 'bars' : 'full'}
        preview={snap.run.awaiting === 'approval'}
        compact={compact}
        total={track.total}
      />
      <div className="cc-ccpage__main">
        <FleetColumn snap={snap} selected={mapView.selected} onSelect={mapView.select} compact={compact} />
        <MissionMap snap={snap} site={site} view={mapView} />
        <div className="cc-ccpage__side">
          <OperatorPanel snap={snap} turn={turn} startControl={startControl} onExpand={setLightbox} compact={compact} />
          <SuspiciousItemPanel snap={snap} contentsInOperator={turn.kind === 'verdict'} onExpand={setLightbox} />
          <HistoryPanel snap={snap} compact={compact} />
        </div>
      </div>
      <Lightbox
        open={lightbox !== null}
        src={lightbox?.src}
        boxes={lightbox?.boxes}
        aspect={lightbox?.aspect}
        caption={lightbox?.caption}
        meta={lightbox?.meta}
        onClose={() => setLightbox(null)}
      />
    </div>
  )
}
