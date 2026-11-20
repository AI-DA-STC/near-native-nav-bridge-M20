import type { RobotKind, RobotSetupFacts, RobotSuggestion } from '@/shared/api'

/* Adding a robot: its kind, its robot ID (relays.launch.py suffixes every topic with it), its login on its static IP
 * on the robots' router, and its password. The README's robots come first as suggestions; the server checks the same
 * rules again. */

export interface NewRobot {
  kind: RobotKind
  id: string
  ip: string
  /** The ssh login: user on an M20, agilex on the ALOHA */
  user: string
  /** Empty: the README's for the kind (' on an M20, agx on the ALOHA) */
  password: string
}

/** The README's logins, as the form shows them; the server keeps the passwords */
export const DEFAULT_USER: Readonly<Record<RobotKind, string>> = { m20: 'user', aloha: 'agilex' }
const USER = /^[a-z_][a-z0-9_-]{0,31}$/

const ROBOT_ID = /^[A-Za-z0-9_]+$/
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/** Why this robot cannot be added, or null */
export function problemWith(next: NewRobot, robots: readonly RobotSetupFacts[]): string | null {
  const id = next.id.trim()
  const ip = next.ip.trim()
  if (!id) return 'Enter the robot ID'
  if (!ROBOT_ID.test(id)) return 'The robot ID takes letters, digits and _ only: it becomes part of every topic name'
  if (robots.some((r) => r.id === id)) return `Robot ${id} is already in the lobby`
  if (!ip) return 'Enter the robot’s static IP'
  if (!IPV4.test(ip)) return `${ip} is not an IPv4 address, like 192.168.123.100`
  const sameIp = robots.find((r) => r.ip === ip)
  if (sameIp) return `${ip} is robot ${sameIp.id}’s IP`
  const user = next.user.trim()
  if (!user) return 'Enter the login, like user or agilex'
  if (!USER.test(user)) return `${user} is not a login name: lowercase letters, digits, _ and -`
  return null
}

/** The form's values for a kind: the next README robot of that kind not added yet */
export function defaultsFor(kind: RobotKind, suggestions: readonly RobotSuggestion[]): NewRobot {
  const next = suggestions.find((s) => s.kind === kind)
  if (next) return { kind, id: next.id, ip: next.ip, user: next.user ?? DEFAULT_USER[kind], password: '' }
  return { kind, id: kind === 'aloha' ? 'aloha' : '', ip: '', user: DEFAULT_USER[kind], password: '' }
}
