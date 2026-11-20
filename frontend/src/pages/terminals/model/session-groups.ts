import type { RobotKind, RobotSetupFacts, SetupSnapshot, TerminalRole, TerminalSessionFacts } from '@/shared/api'

/* The terminals the setup server holds, by robot: the robot's (ssh, then its relay in the container, or the ALOHA's
 * tmux) before the laptop's (exports, checks, rviz2, the ALOHA's bridge), in the lobby's order; then the Routes
 * recorder's. */

export interface SessionGroup {
  robot: string
  /** null: a robot removed from the lobby whose terminal is still listed, or the Routes recorder (robot "routes") */
  facts: RobotSetupFacts | null
  sessions: TerminalSessionFacts[]
}

const ROLE_ORDER = { robot: 0, laptop: 1, routes: 2 } as const

export function sessionGroups(snapshot: SetupSnapshot): SessionGroup[] {
  const order = snapshot.robots.map((r) => r.id)
  const byRobot = new Map<string, TerminalSessionFacts[]>()
  for (const session of snapshot.sessions) byRobot.set(session.robot, [...(byRobot.get(session.robot) ?? []), session])
  // The recorder after every robot
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : id === 'routes' ? order.length + 1 : order.length)
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

export const ROLE_TITLE = { robot: 'Robot · relay', laptop: 'Laptop', routes: 'Recorder' } as const

/** A terminal's name in the list: the ALOHA's robot terminal holds start_aloha.sh's tmux, its laptop one the bridge */
export function sessionTitle(role: TerminalRole, kind: RobotKind | null): string {
  if (kind === 'aloha' && role === 'robot') return 'Robot · tmux'
  if (kind === 'aloha' && role === 'laptop') return 'Laptop · bridge'
  return ROLE_TITLE[role]
}

/** What the terminal is, in a line: the ALOHA's run start_aloha.sh's tmux and its bridge */
export function sessionAbout(role: TerminalRole, kind: RobotKind | null): string {
  if (kind === 'aloha' && role === 'robot') return 'ssh into the ALOHA as agilex, where start_aloha.sh runs each part in a window of the tmux session aloha (Ctrl+b, then n or p, switches window)'
  if (kind === 'aloha' && role === 'laptop') return 'This workstation in the package root: aloha/bridge.sh, the ALOHA’s topics on ROS_DOMAIN_ID=1'
  return ROLE_ABOUT[role]
}

/** The group's name: the robot's ID, ALOHA, or Routes */
export function groupName(robot: string, snapshot: SetupSnapshot): string {
  if (robot === 'routes') return 'Routes'
  return snapshot.robots.find((r) => r.id === robot)?.kind === 'aloha' ? 'ALOHA' : robot
}

/** What the terminal is, in a line */
export const ROLE_ABOUT: Record<TerminalRole, string> = {
  robot: 'ssh into the robot, su, then the nav_cmd_bridge container running relays.launch.py',
  laptop: 'This workstation in the package root: README exports, topic checks, rviz2, the ALOHA’s bridge',
  routes: 'This workstation in the package root: demo/record_waypoints.sh, one robot and phase at a time',
}
