import type { SetupSnapshot, TerminalSessionFacts } from '@/shared/api'
import { robotName, rolesOf } from '@/shared/config'

/* Fleet health's terminals: the setup server opens a ping dashboard (frontend/server/net_dash.py) for each robot added
 * and one for the router (frontend/server/ping-terminals.ts) */

export interface PingPane {
  session: TerminalSessionFacts
  /** "R1 · 741", "ALOHA", "Router" */
  name: string
}

/** The robots' in the lobby's order, then the router's */
export function pingPanes(snapshot: SetupSnapshot): PingPane[] {
  const roles = rolesOf(snapshot.robots)
  const order = snapshot.robots.map((r) => r.id)
  const rank = (robot: string) => (order.includes(robot) ? order.indexOf(robot) : order.length)
  return snapshot.sessions
    .filter((s) => s.role === 'ping')
    .sort((a, b) => rank(a.robot) - rank(b.robot) || a.robot.localeCompare(b.robot))
    .map((session) => ({ session, name: robotName(session.robot, roles) }))
}

/** The panes in rows of at most three, the fuller rows first: 4 → 2 + 2, 5 → 3 + 2, 7 → 3 + 2 + 2 */
export function rowsOf<T>(items: readonly T[]): T[][] {
  const rows = Math.ceil(items.length / 3)
  const out: T[][] = []
  let at = 0
  for (let i = 0; i < rows; i++) {
    const size = Math.floor(items.length / rows) + (i < items.length % rows ? 1 : 0)
    out.push(items.slice(at, at + size))
    at += size
  }
  return out
}
