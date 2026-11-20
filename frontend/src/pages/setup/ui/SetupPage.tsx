import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useSetupConnection, useSetupSnapshot } from '@/shared/api'
import { cx } from '@/shared/lib'
import { pushToast } from '@/shared/ui/Toast'
import { confirmSetup } from '../api/robot-commands'
import { defaultSelection, notReadyReason } from '../model/roster'
import { AddRobot } from './add-robot/AddRobot'
import { RobotBay } from './bay/RobotBay'
import { Roster } from './roster/Roster'
import './SetupPage.css'

/** The landing page: robots join the lobby one at a time, and each one's setup runs in the bay above it */
export function SetupPage() {
  const snapshot = useSetupSnapshot()
  const connection = useSetupConnection()
  const navigate = useNavigate()
  const now = useNow()
  // The operator's pick; until then the robot that needs attention, else the newest
  const [picked, setPicked] = useState<string | null>(null)

  if (!snapshot) {
    return (
      <div className="cc-setup cc-setup--waiting">
        <p className="cc-setup__connecting">
          {connection === 'connecting' ? 'Connecting to the setup server…' : 'The setup server does not answer. Is npm run dev still running?'}
        </p>
      </div>
    )
  }
  const robots = snapshot.robots
  const selected = picked === 'add' || robots.some((r) => r.id === picked) ? picked! : defaultSelection(robots)
  const robot = robots.find((r) => r.id === selected) ?? null
  const blocked = notReadyReason(robots)
  // Every robot ready: Setup is confirmed, and the Routes are next
  const toRoutes = () =>
    void confirmSetup().then((result) => {
      if (result.ok) navigate('/routes')
      else pushToast({ tone: 'warn', title: 'Not on to Routes yet', body: result.error ?? undefined })
    })
  return (
    <div className={cx('cc-setup', connection === 'closed' && 'is-offline')}>
      {connection === 'closed' ? (
        <p className="cc-setup__lost" role="alert">
          Lost the setup server: retrying. What it runs keeps running; this page catches up when it is back.
        </p>
      ) : null}
      <div className="cc-setup__bay">
        {robot ? (
          <RobotBay
            robot={robot}
            snapshot={snapshot}
            now={now}
            onAddNext={() => setPicked('add')}
            onContinue={toRoutes}
            continueBlocked={blocked}
            onRemoved={() => setPicked(null)}
          />
        ) : (
          <AddRobot robots={robots} suggestions={snapshot.suggestions} onAdded={(id) => setPicked(id)} />
        )}
      </div>
      <Roster snapshot={snapshot} selected={selected} onSelect={setPicked} onContinue={toRoutes} continueBlocked={blocked} now={now} />
    </div>
  )
}

/** The time, every second: for step timers and "last seen" */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return now
}
