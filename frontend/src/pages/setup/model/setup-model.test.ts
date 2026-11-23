import { describe, expect, it } from 'vitest'
import type { RobotSetupFacts, SetupSnapshot, SetupStepFacts, SetupStepKey, SetupStepStatus } from '@/shared/api'
import { defaultsFor, problemWith } from './add-robot'
import { MIN_SLOTS, defaultSelection, identityOf, nextSuggestion, notReadyReason, rosterSummary, slotStatus, slotsOf } from './roster'
import { terminalToOpen, terminalsLink } from './setup-steps'

const NOW = new Date('2026-11-20T10:45:00').getTime()
const KEYS: SetupStepKey[] = ['login', 'image', 'relay', 'laptop', 'topics', 'localize']

function steps(statuses: SetupStepStatus[], prompt: SetupStepFacts['prompt'] = null): SetupStepFacts[] {
  return KEYS.map((key, i) => ({
    key,
    status: statuses[i] ?? 'pending',
    detail: '',
    startedAt: null,
    endedAt: null,
    commands: [],
    checks: [],
    prompt: statuses[i] === 'decision' ? prompt : null,
    error: null,
  }))
}

function robot(over: Partial<RobotSetupFacts> & { state?: RobotSetupFacts['setup']['state']; statuses?: SetupStepStatus[] } = {}): RobotSetupFacts {
  const { state = 'idle', statuses = [], ...rest } = over
  return {
    kind: 'm20',
    id: '741',
    ip: '192.168.123.100',
    user: 'user',
    addedAt: NOW - 60_000,
    presence: 'online',
    presenceSince: NOW - 60_000,
    lastSeen: NOW,
    setup: { state, steps: steps(statuses), startedAt: null, endedAt: null },
    relay: { state: 'none', since: null, rateHz: null },
    nav: { state: 'running', since: null },
    lastReadyAt: null,
    sessions: { robot: null, laptop: null, nav: null },
    ...rest,
  }
}

const snapshot = (robots: RobotSetupFacts[]): SetupSnapshot => ({
  serverTime: NOW,
  robots,
  suggestions: [
    { kind: 'm20', id: '665', ip: '192.168.123.101', user: 'user', presence: 'offline' },
    { kind: 'm20', id: '738', ip: '192.168.123.103', user: 'user', presence: 'online' },
  ],
  sessions: [],
  flow: { setupConfirmedAt: null, plan: null, unlocked: false },
  plans: [],
  session: null,
  participants: { patrol: [], formation: [], sweep: [], cordon: [], aloha: [] },
})

describe('a robot’s seat in the lobby', () => {
  it('fades out and says when it was last seen while it does not answer', () => {
    const s = slotStatus(robot({ presence: 'offline', lastSeen: NOW - 120_000 }), NOW)
    expect(s).toMatchObject({ word: 'OFFLINE', presence: 'offline', detail: 'Last seen 10:43:00' })
  })

  it('checks before it knows', () => {
    expect(slotStatus(robot({ presence: 'unknown' }), NOW)).toMatchObject({ word: 'CHECKING', presence: 'checking' })
  })

  it('is online and not set up yet', () => {
    expect(slotStatus(robot(), NOW)).toMatchObject({ word: 'ONLINE', tone: 'ok', detail: 'Not set up yet' })
  })

  it('counts the step it is on while it sets up', () => {
    const s = slotStatus(robot({ state: 'running', statuses: ['done', 'done', 'active'] }), NOW)
    expect(s).toMatchObject({ word: 'SETTING UP', tone: 'live', detail: '3 of 6 · Start relay', pulse: true })
  })

  it('needs the operator while a step waits', () => {
    const r = robot({ state: 'waiting' })
    r.setup.steps = steps(['done', 'done', 'done', 'done', 'done', 'decision'], { kind: 'localize', rviz: 'running', pose: null })
    expect(slotStatus(r, NOW)).toMatchObject({ word: 'NEEDS YOU', tone: 'accent', detail: 'Localize: set its pose in RViz' })
  })

  it('is ready with its relay’s rate, and says when the relay stopped', () => {
    const done = { state: 'done' as const, statuses: Array<SetupStepStatus>(6).fill('done') }
    expect(slotStatus(robot({ ...done, relay: { state: 'running', since: NOW, rateHz: 9.98 } }), NOW)).toMatchObject({ word: 'READY', detail: 'Relay at 10.0 Hz' })
    expect(slotStatus(robot({ ...done, relay: { state: 'exited', since: NOW, rateHz: null } }), NOW)).toMatchObject({ word: 'RELAY STOPPED', tone: 'warn' })
  })

  it('is set up like the dogs for the ALOHA, its bridge in place of a relay', () => {
    const aloha = robot({ kind: 'aloha', id: 'aloha', ip: '192.168.123.200', user: 'agilex', state: 'done', relay: { state: 'running', since: NOW, rateHz: 10.04 } })
    expect(slotStatus(aloha, NOW)).toMatchObject({ word: 'READY', detail: 'Bridge: /scan at 10.0 Hz' })
    expect(slotStatus({ ...aloha, relay: { state: 'exited', since: NOW, rateHz: null } }, NOW).word).toBe('BRIDGE STOPPED')
  })

  it('goes on to Routes only when every robot is ready', () => {
    const ready = robot({ state: 'done', relay: { state: 'running', since: NOW, rateHz: 10 } })
    expect(notReadyReason([ready])).toBeNull()
    expect(notReadyReason([ready, robot({ id: '665', presence: 'offline' })])).toBe('Not ready yet: 665')
    expect(notReadyReason([])).toBe('Add the robots first')
  })

  it('carries the demo’s identity for the README robots', () => {
    expect(identityOf({ kind: 'm20', id: '741' })).toBe('r1')
    expect(identityOf({ kind: 'm20', id: '738' })).toBe('r3')
    expect(identityOf({ kind: 'm20', id: '999' })).toBeNull()
    expect(identityOf({ kind: 'aloha', id: 'aloha' })).toBe('aloha')
  })
})

describe('the lobby', () => {
  it('always shows its empty seats, after the Add seat', () => {
    expect(slotsOf(snapshot([])).map((s) => s.kind)).toEqual(['add', 'empty', 'empty', 'empty'])
    const four = ['741', '665', '738', '700'].map((id, i) => robot({ id, ip: `192.168.123.${100 + i}` }))
    expect(slotsOf(snapshot(four))).toHaveLength(MIN_SLOTS + 1)
  })

  it('suggests an online README robot first', () => {
    expect(nextSuggestion(snapshot([]).suggestions)?.id).toBe('738')
  })

  it('opens on the robot that needs the operator, else the newest that answers', () => {
    const a = robot({ id: '741' })
    const b = robot({ id: '665', ip: '192.168.123.101', state: 'waiting' })
    const c = robot({ id: '738', ip: '192.168.123.103' })
    expect(defaultSelection([a, b, c])).toBe('665')
    expect(defaultSelection([a, c])).toBe('738')
    expect(defaultSelection([a, { ...c, presence: 'offline' }])).toBe('741')
    expect(defaultSelection([])).toBe('add')
  })

  it('sums up its robots in a line', () => {
    const a = robot()
    const b = robot({ id: '665', ip: '192.168.123.101', presence: 'offline' })
    expect(rosterSummary([a, b], NOW)).toBe('1 online · 1 offline')
  })
})

describe('adding a robot', () => {
  const robots = [robot()]

  it.each([
    [{ id: '', ip: '192.168.123.101' }, 'Enter the robot ID'],
    [{ id: 'r-1', ip: '192.168.123.101' }, 'The robot ID takes letters, digits and _ only: it becomes part of every topic name'],
    [{ id: '741', ip: '192.168.123.101' }, 'Robot 741 is already in the lobby'],
    [{ id: '665', ip: '192.168.123' }, '192.168.123 is not an IPv4 address, like 192.168.123.100'],
    [{ id: '665', ip: '192.168.123.100' }, '192.168.123.100 is robot 741’s IP'],
    [{ id: '665', ip: '192.168.123.101', user: '' }, 'Enter the login, like user or agilex'],
    [{ id: '665', ip: '192.168.123.101', user: 'User;rm' }, 'User;rm is not a login name: lowercase letters, digits, _ and -'],
  ])('refuses %j', (form, problem) => {
    expect(problemWith({ kind: 'm20', user: 'user', password: '', ...form }, robots)).toBe(problem)
  })

  it('takes a new ID, login and IP', () => {
    expect(problemWith({ kind: 'm20', id: '665', ip: '192.168.123.101', user: 'user', password: 'x' }, robots)).toBeNull()
  })

  it('starts from the next README robot of the kind, with its login and the README’s password', () => {
    expect(defaultsFor('m20', snapshot([]).suggestions)).toEqual({ kind: 'm20', id: '665', ip: '192.168.123.101', user: 'user', password: '' })
    expect(defaultsFor('aloha', [])).toEqual({ kind: 'aloha', id: 'aloha', ip: '', user: 'agilex', password: '' })
  })
})

describe('Open in Terminals', () => {
  const sessions = { robot: '741-robot-1', laptop: '741-laptop-2', nav: null }

  it('opens the terminal the current step types into', () => {
    expect(terminalToOpen(robot({ state: 'running', statuses: ['done', 'active'], sessions }))).toEqual({ session: '741-robot-1', role: 'robot' })
    expect(terminalToOpen(robot({ state: 'failed', statuses: ['done', 'done', 'done', 'done', 'failed'], sessions }))).toEqual({
      session: '741-laptop-2',
      role: 'laptop',
    })
  })

  it('falls back to the terminal that is open, and is not there before the setup opens one', () => {
    const laptopStep = robot({ state: 'running', statuses: ['done', 'done', 'done', 'active'], sessions: { robot: '741-robot-1', laptop: null, nav: null } })
    expect(terminalToOpen(laptopStep)).toEqual({ session: '741-robot-1', role: 'robot' })
    expect(terminalToOpen(robot())).toBeNull()
  })

  it('links to the session on the Terminals screen', () => {
    expect(terminalsLink('741-robot-1')).toBe('/terminals?session=741-robot-1')
  })
})
