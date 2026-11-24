import type { RobotKind, RobotSetupFacts, SetupSnapshot, TerminalRole, TerminalSessionFacts } from '@/shared/api'
import { ROUTER_ID } from '@/shared/config'

/* The terminals the setup server holds, by robot: the robot's (ssh, then its relay in the container, or the ALOHA's
 * tmux) before the laptop's (exports, checks, rviz2, the ALOHA's bridge), in the lobby's order; then Routes': the
 * recorder and the RViz windows it draws in. */

export interface SessionGroup {
  robot: string
  /** null: a robot removed from the lobby whose terminal is still listed, or the Routes recorder (robot "routes") */
  facts: RobotSetupFacts | null
  sessions: TerminalSessionFacts[]
}

const ROLE_ORDER: Readonly<Record<TerminalRole, number>> = { robot: 0, laptop: 1, nav: 2, ping: 3, routes: 4, 'rviz-dogs': 5, 'rviz-aloha': 6, mission: 7 }

export function sessionGroups(snapshot: SetupSnapshot): SessionGroup[] {
  const order = snapshot.robots.map((r) => r.id)
  const byRobot = new Map<string, TerminalSessionFacts[]>()
  for (const session of snapshot.sessions) byRobot.set(session.robot, [...(byRobot.get(session.robot) ?? []), session])
  // The recorder after every robot
  // Routes' terminals, then the mission's, after every robot
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : id === 'routes' ? order.length + 1 : id === 'mission' ? order.length + 2 : order.length)
  return [...byRobot]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([robot, sessions]) => ({
      robot,
      facts: snapshot.robots.find((r) => r.id === robot) ?? null,
      sessions: sessions.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]),
    }))
}

/** The session the page opens on: the one asked for, else a relay that runs, else the first robot terminal */
export function pickSession(snapshot: SetupSnapshot, wanted: string | null): TerminalSessionFacts | null {
  const all = sessionGroups(snapshot).flatMap((g) => g.sessions)
  return (
    all.find((s) => s.id === wanted) ??
    all.find((s) => s.role === 'robot' && s.state === 'running') ??
    all.find((s) => s.role === 'robot') ??
    all[0] ??
    null
  )
}

export const ROLE_TITLE: Readonly<Record<TerminalRole, string>> = {
  robot: 'Robot · relay',
  laptop: 'Laptop',
  nav: 'Laptop · nav bridge',
  ping: 'Network · ping',
  routes: 'Recorder',
  'rviz-dogs': 'RViz · dogs',
  'rviz-aloha': 'RViz · ALOHA',
  mission: 'Mission · run_demo.sh',
}

/** A terminal's name in the list: the ALOHA's robot terminal holds start_aloha.sh's tmux, its laptop one the bridge */
export function sessionTitle(role: TerminalRole, kind: RobotKind | null): string {
  if (kind === 'aloha' && role === 'robot') return 'Robot · tmux'
  if (kind === 'aloha' && role === 'laptop') return 'Laptop · bridge'
  if (kind === 'aloha' && role === 'nav') return 'Laptop · RViz'
  return ROLE_TITLE[role]
}

/** What the terminal is, in a line: the ALOHA's run start_aloha.sh's tmux and its bridge */
export function sessionAbout(role: TerminalRole, kind: RobotKind | null): string {
  if (kind === 'aloha' && role === 'robot') return 'ssh into the ALOHA as agilex, where start_aloha.sh runs each part in a window of the tmux session aloha (Ctrl+b, then n or p, switches window)'
  if (kind === 'aloha' && role === 'laptop') return 'This workstation in the package root: aloha/bridge.sh, the ALOHA’s topics on ROS_DOMAIN_ID=1'
  if (kind === 'aloha' && role === 'nav') return 'This workstation: RViz on the ALOHA’s own map (ROS_DOMAIN_ID=1), where its setup has you set its 2D Pose Estimate'
  return ROLE_ABOUT[role]
}

/** The group's name: the robot's ID, ALOHA, Routes, Mission or Router */
export function groupName(robot: string, snapshot: SetupSnapshot): string {
  if (robot === 'routes') return 'Routes'
  if (robot === 'mission') return 'Mission'
  if (robot === ROUTER_ID) return 'Router'
  return snapshot.robots.find((r) => r.id === robot)?.kind === 'aloha' ? 'ALOHA' : robot
}

/** What the terminal is, in a line */
export const ROLE_ABOUT: Record<TerminalRole, string> = {
  robot: 'ssh into the robot, su, then the nav_cmd_bridge container running relays.launch.py',
  laptop: 'This workstation in the package root: README exports, topic checks, rviz2, the ALOHA’s bridge',
  nav: 'This workstation: the robot’s nav bridge (README Multi-robot Step 1), which the mission’s goals go through',
  ping: 'This workstation: frontend/server/net_dash.py, a ping a second with its latency now, over the last period and since it started (p period, r restart totals, q quit)',
  routes: 'This workstation in the package root: demo/record_waypoints.sh, one robot and phase at a time',
  'rviz-dogs': 'This workstation: the RViz the dogs’ routes are recorded in (ROS_DOMAIN_ID=0), on their map with /fleet_goal_markers',
  'rviz-aloha': 'This workstation: the RViz the ALOHA’s route is recorded in (ROS_DOMAIN_ID=1), on its own map with /fleet_goal_markers',
  mission: 'This workstation in the package root: demo/run_demo.sh on the confirmed plan, started by Start mission',
}

/** Beside a group's name when it is not a robot added: what it is */
export function groupNote(robot: string): string {
  if (robot === 'routes') return 'recorder'
  if (robot === 'mission') return 'run_demo.sh'
  if (robot === ROUTER_ID) return 'gateway'
  return 'removed'
}
