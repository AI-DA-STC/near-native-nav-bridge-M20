import { Navigate, useNavigate } from 'react-router'
import { CommandCenterPage } from '@/pages/command-center'
import { LandingPage } from '@/pages/landing'
import { useSetupConnection, useSetupSnapshot } from '@/shared/api'
import { MissionGate } from './AppShell'
import { flowOf, nextScreen } from './flow'
import { OperatorStartMission } from './MissionActions'

/** The landing page: Launch goes on to the first step not confirmed */
export function LandingRoute() {
  const navigate = useNavigate()
  const flow = flowOf(useSetupSnapshot())
  return <LandingPage onLaunch={() => navigate(nextScreen(flow))} />
}

/** The Command center, once Setup and Routes are confirmed; before, the step still missing */
export function MissionRoute() {
  const snapshot = useSetupSnapshot()
  const connection = useSetupConnection()
  if (!snapshot) {
    return <p className="cc-shell__connecting">{connection === 'connecting' ? 'Connecting to the setup server…' : 'The setup server does not answer.'}</p>
  }
  const flow = flowOf(snapshot)
  if (!flow.missionOpen) return <Navigate to={nextScreen(flow)} replace />
  return (
    <MissionGate>
      <CommandCenterPage startControl={<OperatorStartMission />} />
    </MissionGate>
  )
}
