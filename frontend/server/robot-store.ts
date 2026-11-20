import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { RobotKind } from '../src/shared/api/setup-protocol.ts'
import { DEFAULT_LOGIN } from './readme-commands.ts'

/* The robots added in the lobby, kept on this workstation between runs (server/robots.json, not in git, readable by its
 * owner only: it holds the robots' passwords). Only what the operator entered is kept, and when each was last ready:
 * presence and setup are live facts. */

export interface StoredRobot {
  kind: RobotKind
  id: string
  ip: string
  /** The ssh login: user on an M20, agilex on the ALOHA */
  user: string
  /** For ssh, and su on an M20. Never sent to a browser. */
  password: string
  addedAt: number
  lastReadyAt: number | null
}

function isStoredRobot(value: unknown): value is StoredRobot {
  const r = value as StoredRobot
  return (
    typeof r === 'object' &&
    r !== null &&
    (r.kind === 'm20' || r.kind === 'aloha') &&
    typeof r.id === 'string' &&
    typeof r.ip === 'string' &&
    typeof r.addedAt === 'number'
  )
}

export class RobotStore {
  private readonly file: string

  constructor(file: string) {
    this.file = file
  }

  load(): StoredRobot[] {
    if (!existsSync(this.file)) return []
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      const robots = (parsed as { robots?: unknown }).robots
      if (!Array.isArray(robots)) throw new Error('no robots array')
      // Robots saved before logins were asked for get the README's
      return robots.filter(isStoredRobot).map((r) => ({
        ...r,
        user: typeof r.user === 'string' && r.user ? r.user : DEFAULT_LOGIN[r.kind].user,
        password: typeof r.password === 'string' ? r.password : DEFAULT_LOGIN[r.kind].password,
        lastReadyAt: r.lastReadyAt ?? null,
      }))
    } catch (error) {
      // Keep the unreadable file for a look, and start empty
      const aside = `${this.file}.unreadable-${Date.now()}`
      renameSync(this.file, aside)
      console.warn(`[setup] ${this.file} could not be read (${String(error)}); moved to ${aside}`)
      return []
    }
  }

  save(robots: StoredRobot[]): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ robots }, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, this.file)
  }
}
