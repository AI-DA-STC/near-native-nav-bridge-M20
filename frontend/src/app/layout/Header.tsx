import { useLocation, useNavigate } from 'react-router'
import { useConnectionStatus, type MissionSnapshot } from '@/shared/api'
import { AttentionRow } from '@/shared/ui/AttentionChip'
import type { TabItem } from '@/shared/ui/Tabs'
import { AppHeader } from './AppHeader'
import { headerStateOf } from './header-state'
import { MissionActions } from './MissionActions'
import { fireEStop } from './mission-controls'

const NOT_BUILT = 'Comes in a later round'

/** The screens, as in the console; the later ones show disabled until their pages exist */
const TABS: TabItem[] = [
  { id: '/', label: 'Command center' },
  { id: '/fleet-health', label: 'Fleet health', disabled: true, title: NOT_BUILT },
  { id: '/routes', label: 'Routes', disabled: true, title: NOT_BUILT },
  { id: '/log', label: 'Log', disabled: true, title: NOT_BUILT },
]

export function Header({ snap }: { snap: MissionSnapshot }) {
  const header = headerStateOf(snap, useConnectionStatus())
  const navigate = useNavigate()
  const { pathname } = useLocation()
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
      tabs={TABS}
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
