import { useLocation, useNavigate } from 'react-router'
import { useSetupConnection, useSetupSnapshot } from '@/shared/api'
import { AppHeader } from './AppHeader'
import { flowOf } from './flow'
import { navTabs } from './nav-tabs'
import { routesHeaderOf, setupHeaderOf } from './setup-header-state'

const SUBTITLE: Record<string, string> = { '/routes': 'routes', '/terminals': 'terminals' }

/** The header on Setup, Routes and Terminals: the fleet's setup state (or the routes' on Routes) instead of the
 * mission's, and no mission actions, clock or E-STOP. Setting up moves no robot; E-STOP is on the Command center, where
 * missions run. */
export function SetupHeader() {
  const snapshot = useSetupSnapshot()
  const connection = useSetupConnection()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const header = pathname === '/routes' ? routesHeaderOf(snapshot, connection) : setupHeaderOf(snapshot, connection)
  return (
    <AppHeader
      subtitle={SUBTITLE[pathname] ?? 'fleet setup'}
      running={header.running}
      state={header.state}
      stateLabel={header.label}
      stateDetail={header.detail}
      tabs={navTabs(flowOf(snapshot))}
      tab={pathname}
      onTab={(path) => navigate(path)}
    />
  )
}
