import { useState, type ReactNode } from 'react'
import { useMissionSnapshot } from '@/shared/api'
import type { RobotKey } from '@/shared/config'
import { cx, useCompactLayout } from '@/shared/lib'
import { Lightbox } from '@/shared/ui/Lightbox'
import { useSiteMap } from '../api/fetch-site-map'
import { cameraTilesOf } from '../model/camera-feeds'
import { useMapView } from '../model/map-view'
import { operatorTurnOf } from '../model/operator-turn'
import { phaseTrackOf } from '../model/phase-track'
import type { ImageView } from '../model/suspicious-item'
import { taskLanesOf } from '../model/task-lanes'
import { useMinimized } from '../model/use-minimized'
import { CameraStrip } from './cameras/CameraStrip'
import { HistoryPanel } from './history/HistoryPanel'
import { MissionMap } from './mission-map/MissionMap'
import { OperatorPanel } from './operator/OperatorPanel'
import { PhaseBar } from './phase-track/PhaseBar'
import { PhaseTrack } from './phase-track/PhaseTrack'
import { SuspiciousItemPanel } from './suspicious-item/SuspiciousItemPanel'
import './CommandCenterPage.css'

export interface CommandCenterPageProps {
  /** Start mission: the app owns the command and hands its button to the Operator panel before the start */
  startControl?: ReactNode
}

/** The one screen that runs the whole mission: the phases across the top, the robots' cameras under them over the map,
 * and the side column of Operator, Suspicious item and History. The phases and the cameras each minimize to one line,
 * as the operator chooses. When space is tight these survive in order: where the mission is and what comes next,
 * whether it is the operator's turn, where each robot is, what has been found, what is wrong, history. */
export function CommandCenterPage({ startControl }: CommandCenterPageProps) {
  const snap = useMissionSnapshot()
  const site = useSiteMap(snap?.siteVersion)
  const alohaSite = useSiteMap(snap?.siteVersion, 'aloha')
  const compact = useCompactLayout()
  const mapView = useMapView()
  const [phasesMin, setPhasesMin] = useMinimized('cc.command-center.phases-minimized')
  const [camerasMin, setCamerasMin] = useMinimized('cc.command-center.cameras-minimized')
  // A photo, or a camera's feed, which keeps updating while it is enlarged
  const [enlarged, setEnlarged] = useState<{ image: ImageView } | { camera: RobotKey } | null>(null)
  if (!snap) return null
  const track = phaseTrackOf(snap)
  const turn = operatorTurnOf(snap)
  const setLightbox = (image: ImageView) => setEnlarged({ image })
  const lightbox = enlarged === null ? null : 'image' in enlarged ? enlarged.image : (cameraTilesOf(snap).find((t) => t.robot === enlarged.camera)?.image ?? null)
  return (
    <div className={cx('cc-ccpage', compact && 'is-compact')}>
      {phasesMin ? (
        <PhaseBar phases={track.phases} total={track.total} onExpand={() => setPhasesMin(false)} />
      ) : (
        <PhaseTrack
          phases={track.phases}
          loops={track.loops}
          lanes={taskLanesOf(snap)}
          lanesMode={compact ? 'bars' : 'full'}
          preview={snap.run.awaiting === 'approval'}
          compact={compact}
          total={track.total}
          onMinimize={() => setPhasesMin(true)}
        />
      )}
      <div className="cc-ccpage__main">
        <div className="cc-ccpage__centre">
          <CameraStrip tiles={cameraTilesOf(snap)} minimized={camerasMin} onMinimize={setCamerasMin} onExpand={(camera) => setEnlarged({ camera })} compact={compact} />
          <div className="cc-ccpage__mapcell">
            <MissionMap snap={snap} site={site} alohaSite={alohaSite} view={mapView} />
          </div>
        </div>
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
        onClose={() => setEnlarged(null)}
      />
    </div>
  )
}
