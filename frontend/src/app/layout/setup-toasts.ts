import { useEffect, useRef } from 'react'
import { useSetupSnapshot, type RobotSetupFacts } from '@/shared/api'
import { pushToast } from '@/shared/ui/Toast'

/* Toasts for what happens to the robots while the operator looks at another screen: a robot joined, is ready, went
 * offline, or its relay stopped. A step that waits for the operator is the setup page's hot panel, not a toast. */

const name = (r: RobotSetupFacts) => (r.kind === 'aloha' ? 'ALOHA' : r.id)

export function useSetupToasts(): void {
  const snapshot = useSetupSnapshot()
  const before = useRef<Map<string, RobotSetupFacts> | null>(null)
  useEffect(() => {
    if (!snapshot) return
    const previous = before.current
    before.current = new Map(snapshot.robots.map((r) => [r.id, r]))
    if (!previous) return
    for (const robot of snapshot.robots) {
      const was = previous.get(robot.id)
      if (!was) {
        pushToast({ title: `${name(robot)} joined the lobby`, body: robot.ip })
        continue
      }
      if (was.presence === 'online' && robot.presence === 'offline') pushToast({ tone: 'warn', title: `${name(robot)} went offline`, body: `No answer at ${robot.ip}` })
      if (was.presence === 'offline' && robot.presence === 'online') pushToast({ tone: 'ok', title: `${name(robot)} is back online` })
      if (was.setup.state !== 'done' && robot.setup.state === 'done') pushToast({ tone: 'ok', title: `${name(robot)} is ready` })
      if (was.setup.state !== 'failed' && robot.setup.state === 'failed') pushToast({ tone: 'fault', title: `${name(robot)}’s setup failed`, body: 'See its steps on the Setup screen' })
      if (was.relay.state === 'running' && robot.relay.state === 'exited' && robot.setup.state === 'done') {
        pushToast({ tone: 'warn', title: `${name(robot)}’s relay stopped`, body: 'Run its setup again to restart it' })
      }
    }
  }, [snapshot])
}
