/** The demo's robots: 'r1' (R1 · 741), 'r2' (R2 · 665), 'r3' (R3 · 738) and 'aloha' (the Mobile ALOHA) */
export type RobotKey = 'r1' | 'r2' | 'r3' | 'aloha'

export interface RobotIdentity {
  key: RobotKey
  /** "R1" … "ALOHA", always shown beside the robot's colour */
  label: string
  /** The ID the scripts name the robot by ("Robot 665"); the ALOHA has none */
  id: string
  kind: 'dog' | 'aloha'
  /** Its static IP on the robots' router (README: "near-robots-5G"), what the setup lobby suggests */
  ip: string
  /** The identity colour, as a CSS value: map glyph, trail, route, lane, tags */
  color: string
}

/** In the fleet's order: the three dogs, then the ALOHA */
export const ROBOT_KEYS: readonly RobotKey[] = ['r1', 'r2', 'r3', 'aloha']

export const FLEET: Readonly<Record<RobotKey, RobotIdentity>> = {
  r1: { key: 'r1', label: 'R1', id: '741', kind: 'dog', ip: '192.168.123.100', color: 'var(--robot-r1)' },
  r2: { key: 'r2', label: 'R2', id: '665', kind: 'dog', ip: '192.168.123.101', color: 'var(--robot-r2)' },
  r3: { key: 'r3', label: 'R3', id: '738', kind: 'dog', ip: '192.168.123.103', color: 'var(--robot-r3)' },
  // The devcontainer's "agilex" host
  aloha: { key: 'aloha', label: 'ALOHA', id: '', kind: 'aloha', ip: '192.168.123.200', color: 'var(--robot-aloha)' },
}

export function robotOf(key: RobotKey): RobotIdentity {
  return FLEET[key]
}

/** A robot key, as opposed to a tone or a label: dots and bars accept either */
export function isRobotKey(value: string | null | undefined): value is RobotKey {
  return value === 'r1' || value === 'r2' || value === 'r3' || value === 'aloha'
}

/** fleet_management.py's marker colours (COLORS), in its order: in RViz a robot takes the one at its place in the phase's
 * file. A guard test keeps these as the script has them. */
export const RVIZ_MARKER_COLORS: ReadonlyArray<{ name: string; rgb: readonly [number, number, number] }> = [
  { name: 'blue', rgb: [0.3, 0.6, 1.0] },
  { name: 'orange', rgb: [1.0, 0.6, 0.2] },
  { name: 'magenta', rgb: [0.9, 0.3, 0.9] },
  { name: 'green', rgb: [0.3, 0.9, 0.4] },
]
