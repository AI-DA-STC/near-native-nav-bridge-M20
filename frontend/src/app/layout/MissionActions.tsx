import { useState } from 'react'
import { useMissionSnapshot, type MissionSnapshot } from '@/shared/api'
import { Button } from '@/shared/ui/Button'
import { ConfirmModal } from '@/shared/ui/ConfirmModal'
import { forceStopIn, sendMissionCommand, startBlockedBy } from './mission-controls'

export interface StartMissionProps {
  snap: MissionSnapshot
  /** The Operator panel's copy is the primary one and shows the reason once; the header's carries it as its tooltip */
  placement: 'operator' | 'header'
}

export function StartMission({ snap, placement }: StartMissionProps) {
  const blocked = startBlockedBy(snap)
  const operator = placement === 'operator'
  return (
    <Button
      variant={operator ? 'primary' : 'secondary'}
      size={operator ? 'lg' : 'md'}
      block={operator}
      icon="play"
      disabled={blocked !== null}
      reason={operator ? blocked : undefined}
      title={operator ? undefined : (blocked ?? undefined)}
      onClick={() => void sendMissionCommand({ type: 'start' }, 'Mission started')}
    >
      Start mission
    </Button>
  )
}

/** Start mission for the page's Operator panel: the app owns the command, the page only places the button */
export function OperatorStartMission() {
  const snap = useMissionSnapshot()
  return snap ? <StartMission snap={snap} placement="operator" /> : null
}

/** The header's mission actions: Start mission; then Stop mission, which becomes Force stop if the mission hasn't ended
 * 8 s after it */
export function MissionActions({ snap }: { snap: MissionSnapshot }) {
  const [confirm, setConfirm] = useState<'stop' | 'force' | null>(null)
  const close = () => setConfirm(null)
  const { status } = snap.run
  const forceIn = forceStopIn(snap)

  let action
  if (status === 'idle' || status === 'ended') {
    action = <StartMission snap={snap} placement="header" />
  } else if (status === 'running') {
    action = (
      <Button icon="stop" onClick={() => setConfirm('stop')}>
        Stop mission
      </Button>
    )
  } else if (forceIn !== null && forceIn > 0) {
    action = (
      <Button icon="stop" disabled title={`Each robot is finishing its waypoint; Force stop in ${Math.ceil(forceIn / 1000)} s`}>
        Stopping…
      </Button>
    )
  } else {
    action = (
      <Button variant="danger" icon="stop" onClick={() => setConfirm('force')}>
        Force stop
      </Button>
    )
  }

  return (
    <>
      {action}
      <ConfirmModal
        open={confirm === 'stop'}
        tone="danger"
        icon="stop"
        title="Stop the mission?"
        confirmLabel="Stop mission"
        onCancel={close}
        onConfirm={() => {
          close()
          void sendMissionCommand({ type: 'stop' }, 'Stop sent: no new waypoints')
        }}
      >
        <p>No new waypoints are sent. Each robot finishes the one it is driving to and the ALOHA’s arms freeze where they are.</p>
        <p>If the mission hasn’t ended 8 s later, this becomes Force stop.</p>
      </ConfirmModal>
      <ConfirmModal
        open={confirm === 'force'}
        tone="danger"
        icon="stop"
        title="Force stop the mission?"
        confirmLabel="Force stop"
        onCancel={close}
        onConfirm={() => {
          close()
          void sendMissionCommand({ type: 'force-stop' }, 'Mission script killed')
        }}
      >
        <p>The mission script has not ended 8 s after Stop mission. Force stop kills it; each robot keeps the waypoint it was given.</p>
      </ConfirmModal>
    </>
  )
}
