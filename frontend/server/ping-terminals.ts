import { readFileSync } from 'node:fs'
import { ROUTER_ID, robotName, rolesOf } from '../src/shared/config/fleet.ts'

/* Fleet health: a ping dashboard (net_dash.py, beside this file) for each robot added in Setup and one for the router,
 * each in a laptop terminal of its own. The router is this workstation's default gateway: the robots' router, which
 * tells a robot's bad link from the Wi-Fi's. */

export interface PingTarget {
  /** Its terminal's robot: the robot's ID, or ROUTER_ID */
  key: string
  /** What the dashboard calls it: "R1 · 741", "ALOHA", "Router" */
  name: string
  ip: string
}

const RTF_UP = 0x1
const RTF_GATEWAY = 0x2

/** The default route's gateway in /proc/net/route's table (the lowest metric's), or null: no network */
export function defaultGateway(table: string): string | null {
  let best: { ip: string; metric: number } | null = null
  for (const line of table.split('\n').slice(1)) {
    const [, destination, gateway, flags, , , metric, mask] = line.trim().split(/\s+/)
    if (destination !== '00000000' || mask !== '00000000' || !gateway) continue
    if ((parseInt(flags, 16) & (RTF_UP | RTF_GATEWAY)) !== (RTF_UP | RTF_GATEWAY)) continue
    const n = parseInt(gateway, 16) // little-endian
    const ip = [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24].join('.')
    if (!best || Number(metric) < best.metric) best = { ip, metric: Number(metric) }
  }
  return best?.ip ?? null
}

export function readDefaultGateway(): string | null {
  try {
    return defaultGateway(readFileSync('/proc/net/route', 'utf8'))
  } catch {
    return null
  }
}

/** One per robot added, in the lobby's order, then the router unless a robot has its IP */
export function pingTargets(robots: readonly { id: string; kind: 'm20' | 'aloha'; ip: string }[], router: string | null): PingTarget[] {
  const roles = rolesOf(robots)
  const targets: PingTarget[] = robots.map((r) => ({ key: r.id, name: robotName(r.id, roles), ip: r.ip }))
  if (router && !robots.some((r) => r.ip === router)) targets.push({ key: ROUTER_ID, name: robotName(ROUTER_ID, roles), ip: router })
  return targets
}

/** What its terminal is typed, from the package root */
export function pingCommand(target: PingTarget): string {
  return `python3 frontend/server/net_dash.py --name '${target.name.replace(/'/g, `'\\''`)}' ${target.ip}`
}
