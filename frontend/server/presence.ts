import { connect } from 'node:net'
import type { Presence } from '../src/shared/api/setup-protocol.ts'

/* Whether each robot answers on the network: a TCP connect to its SSH port every 2 s. A robot turns offline after two
 * misses in a row, so one dropped packet on the WiFi does not make it flicker. */

const INTERVAL_MS = 2000
const TIMEOUT_MS = 1500
const MISSES_TO_OFFLINE = 2

export interface PresenceTarget {
  /** The robot's ID, or "suggestion:<id>" for a README robot not added yet */
  key: string
  ip: string
  /** Tried in order; any answer counts. The ALOHA also answers on its ROS master's port. */
  ports: number[]
}

export interface PresenceFacts {
  presence: Presence
  since: number
  lastSeen: number | null
}

/** Resolves true if something accepts a TCP connection on ip:port before the timeout */
export function answers(ip: string, port: number, timeoutMs = TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: ip, port })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

export class PresenceMonitor {
  private targets = new Map<string, PresenceTarget>()
  private readonly facts = new Map<string, PresenceFacts & { misses: number }>()
  /** Each target is probed on its own: one that times out does not hold the others back */
  private readonly probing = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly onChange: () => void

  constructor(onChange: () => void) {
    this.onChange = onChange
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.probeAll(), INTERVAL_MS)
    this.probeAll()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** The robots to watch; a new one (or a new IP) is probed at once */
  setTargets(targets: PresenceTarget[]): void {
    const next = new Map(targets.map((t) => [t.key, t]))
    for (const key of this.facts.keys()) if (next.get(key)?.ip !== this.targets.get(key)?.ip) this.facts.delete(key)
    this.targets = next
    if (this.timer) this.probeAll()
  }

  get(key: string): PresenceFacts {
    const facts = this.facts.get(key)
    return facts ? { presence: facts.presence, since: facts.since, lastSeen: facts.lastSeen } : { presence: 'unknown', since: Date.now(), lastSeen: null }
  }

  private probeAll(): void {
    for (const target of this.targets.values()) void this.probe(target)
  }

  private async probe(target: PresenceTarget): Promise<void> {
    if (this.probing.has(target.key)) return
    this.probing.add(target.key)
    try {
      const results = await Promise.all(target.ports.map((port) => answers(target.ip, port)))
      // Removed, or given another IP, while it was probed
      if (this.targets.get(target.key)?.ip !== target.ip) return
      const ok = results.some(Boolean)
      const now = Date.now()
      const old = this.facts.get(target.key) ?? { presence: 'unknown' as Presence, since: now, lastSeen: null, misses: 0 }
      const misses = ok ? 0 : old.misses + 1
      const presence: Presence = ok ? 'online' : misses >= MISSES_TO_OFFLINE ? 'offline' : old.presence
      this.facts.set(target.key, { presence, since: presence === old.presence ? old.since : now, lastSeen: ok ? now : old.lastSeen, misses })
      if (presence !== old.presence) this.onChange()
    } finally {
      this.probing.delete(target.key)
    }
  }
}
