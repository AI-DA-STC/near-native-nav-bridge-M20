import { sendCommand, type MissionCommand, type MissionSnapshot } from '@/shared/api'
import { pushToast } from '@/shared/ui/Toast'

/* Start, Stop mission, Force stop and E-STOP: the only place the app sends them */

export async function sendMissionCommand(command: MissionCommand, sent?: string): Promise<void> {
  const result = await sendCommand(command)
  if (!result.ok) pushToast({ tone: 'warn', title: 'Not done', body: result.reason })
  else if (sent) pushToast({ tone: 'ok', title: sent })
}

/** One click, no confirmation, no keyboard shortcut: the E-STOP banner then reports each robot */
export function fireEStop(): void {
  void sendMissionCommand({ type: 'estop' })
}

/** Why the mission cannot start now; null when it can */
export function startBlockedBy(snap: MissionSnapshot): string | null {
  const { run } = snap
  if (run.status === 'running' || run.status === 'stopping') return 'The mission is running'
  const blocker = run.blockers[0]
  if (!blocker) return null
  return blocker.fix ? `${blocker.text}: ${blocker.fix}` : blocker.text
}

/** Milliseconds until Force stop is offered after Stop mission; null when no stop is under way */
export function forceStopIn(snap: MissionSnapshot): number | null {
  const { run, limits, serverTime } = snap
  if (run.status !== 'stopping' || run.stopRequestedAt === null) return null
  return Math.max(0, run.stopRequestedAt + limits.forceStopAfterMs - serverTime)
}
