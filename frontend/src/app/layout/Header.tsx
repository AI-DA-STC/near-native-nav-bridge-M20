import { useLocation, useNavigate } from 'react-router'
import { useConnectionStatus, useSetupSnapshot, type MissionSnapshot } from '@/shared/api'
import { AttentionRow } from '@/shared/ui/AttentionChip'
import { AppHeader } from './AppHeader'
import { headerStateOf } from './header-state'
import { MissionActions } from './MissionActions'
import { fireEStop } from './mission-controls'
import { flowOf } from './flow'
import { navTabs } from './nav-tabs'

export function Header({ snap }: { snap: MissionSnapshot }) {
  const header = headerStateOf(snap, useConnectionStatus())
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const tabs = navTabs(flowOf(useSetupSnapshot()))
  return (
    <AppHeader
      subtitle={snap.mission.name.toLowerCase()}
      running={header.running}
      state={header.state}
      stateDetail={header.stateDetail}
      clock={header.clock}
      clockLabel={header.clockLabel}
      clockRunning={header.clockRunning}
      actions={<MissionActions snap={snap} />}
      onEStop={fireEStop}
      tabs={tabs}
      tab={pathname}
      onTab={(path) => navigate(path)}
      pills={header.pills}
      attention={
        <AttentionRow
          items={header.attention.map((n) => ({ id: n.id, tone: n.tone, robot: n.robot, text: n.text, fix: n.fix ?? undefined }))}
        />
      }
    />
  )
}
