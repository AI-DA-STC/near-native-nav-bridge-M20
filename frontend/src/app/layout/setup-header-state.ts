import type { RobotSetupFacts, SetupConnection, SetupSnapshot } from '@/shared/api'
import type { MissionState } from './StateChip'

/* The header's state chip on the Setup, Routes and Terminals screens, from the setup server's facts. The setup page's
 * seats say the same per robot (pages/setup/model/roster.ts). */

export interface SetupHeaderState {
  state: MissionState
  label: string
  detail: string | null
  /** The brandmark turns while a setup or a recording runs */
  running: boolean
}

const name = (r: RobotSetupFacts) => (r.kind === 'aloha' ? 'ALOHA' : r.id)

/** Set up, relay (or the ALOHA's bridge) running, still answering */
function ready(robot: RobotSetupFacts): boolean {
  return robot.presence === 'online' && robot.setup.state === 'done' && robot.relay.state !== 'exited'
}

function lost(snapshot: SetupSnapshot | null, connection: SetupConnection): SetupHeaderState | null {
  if (!snapshot) return { state: 'not-ready', label: 'CONNECTING', detail: 'Setup server', running: false }
  if (connection === 'closed') return { state: 'not-ready', label: 'SETUP SERVER LOST', detail: 'Retrying', running: false }
  return null
}

export function setupHeaderOf(snapshot: SetupSnapshot | null, connection: SetupConnection): SetupHeaderState {
  const away = lost(snapshot, connection)
  if (away || !snapshot) return away!
  const robots = snapshot.robots
  const waiting = robots.filter((r) => r.setup.state === 'waiting')
  if (waiting.length) return { state: 'waiting', label: 'WAITING FOR YOU', detail: `Setup of ${waiting.map(name).join(', ')}`, running: true }
  const settingUp = robots.filter((r) => r.setup.state === 'running')
  if (settingUp.length) return { state: 'running', label: 'SETTING UP', detail: settingUp.map(name).join(', '), running: true }
  if (!robots.length) return { state: 'not-ready', label: 'SETUP', detail: 'No robots added yet', running: false }
  const done = robots.filter(ready).length
  if (snapshot.flow?.setupConfirmedAt && done === robots.length) return { state: 'ready', label: 'SETUP CONFIRMED', detail: `${done} of ${robots.length} ready`, running: false }
  if (done === robots.length) return { state: 'ready', label: 'FLEET READY', detail: `${done} of ${robots.length} set up`, running: false }
  return { state: 'not-ready', label: 'SETUP', detail: `${done} of ${robots.length} ready`, running: false }
}

/** "2026-11-20_15-02-10" as the header shows it: "20 Nov 15:02" */
function planWhen(id: string): string {
  const [date, time] = id.split('_')
  const month = new Date(`${date}T00:00:00`).toLocaleString('en-GB', { month: 'short' })
  return `${Number(date.slice(8, 10))} ${month} ${time.slice(0, 5).replace('-', ':')}`
}

export function routesHeaderOf(snapshot: SetupSnapshot | null, connection: SetupConnection): SetupHeaderState {
  const away = lost(snapshot, connection)
  if (away || !snapshot) return away!
  const recording = snapshot.session?.recording
  if (recording && (recording.state === 'starting' || recording.state === 'recording')) {
    return { state: 'running', label: 'RECORDING', detail: `${recording.robot} ${recording.phase}, WP ${recording.waypoints.length}`, running: true }
  }
  if (snapshot.session) return { state: 'waiting', label: 'NEW ROUTES', detail: `Based on ${snapshot.session.basedOn ? planWhen(snapshot.session.basedOn) : 'nothing'}`, running: false }
  const plan = snapshot.flow?.plan
  if (plan) return { state: 'ready', label: 'PLAN CONFIRMED', detail: planWhen(plan.id), running: false }
  return { state: 'not-ready', label: 'ROUTES', detail: 'Pick a plan', running: false }
}
