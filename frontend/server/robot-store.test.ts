import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RobotStore } from './robot-store.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'store-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the robots kept between runs', () => {
  it('keeps each robot’s login, readable by this user only', () => {
    const store = new RobotStore(join(dir, 'robots.json'))
    store.save([{ kind: 'aloha', id: 'aloha', ip: '192.168.123.200', user: 'agilex', password: 'agx', addedAt: 1, lastReadyAt: null }])
    expect(store.load()).toEqual([{ kind: 'aloha', id: 'aloha', ip: '192.168.123.200', user: 'agilex', password: 'agx', addedAt: 1, lastReadyAt: null }])
    expect(statSync(join(dir, 'robots.json')).mode & 0o777).toBe(0o600)
  })

  it('gives robots saved before logins the README’s', () => {
    writeFileSync(join(dir, 'robots.json'), JSON.stringify({ robots: [{ kind: 'm20', id: '741', ip: '192.168.123.100', addedAt: 1, lastReadyAt: null }] }))
    expect(new RobotStore(join(dir, 'robots.json')).load()[0]).toMatchObject({ user: 'user', password: "'" })
  })
})
