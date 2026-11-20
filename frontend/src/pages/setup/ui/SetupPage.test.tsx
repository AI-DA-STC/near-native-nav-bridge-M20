import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router'
import { describe, expect, it } from 'vitest'
import {
  connectSetup,
  type RobotSetupFacts,
  type SetupCommand,
  type SetupSnapshot,
  type SetupSource,
  type SetupStepFacts,
  type SetupStepKey,
  type SetupStepStatus,
} from '@/shared/api'
import { SetupPage } from '@/pages/setup'

/* The lobby on a scripted setup server: what it shows, and the commands it sends */

const KEYS: SetupStepKey[] = ['login', 'image', 'relay', 'laptop', 'topics', 'localize']

function steps(statuses: SetupStepStatus[], keys: SetupStepKey[] = KEYS): SetupStepFacts[] {
  return keys.map((key, i) => ({
    key,
    status: statuses[i] ?? 'pending',
    detail: '',
    startedAt: null,
    endedAt: null,
    commands: [],
    checks: [],
    prompt: null,
    error: null,
  }))
}

function robot(over: Partial<RobotSetupFacts> = {}): RobotSetupFacts {
  return {
    kind: 'm20',
    id: '741',
    ip: '192.168.123.100',
    user: 'user',
    addedAt: Date.now() - 60_000,
    presence: 'online',
    presenceSince: Date.now() - 60_000,
    lastSeen: Date.now(),
    setup: { state: 'idle', steps: steps([]), startedAt: null, endedAt: null },
    relay: { state: 'none', since: null, rateHz: null },
    lastReadyAt: null,
    sessions: { robot: null, laptop: null },
    ...over,
  }
}

function setUp(robots: RobotSetupFacts[]) {
  let snapshot: SetupSnapshot = {
    serverTime: Date.now(),
    robots,
    suggestions: [
      { kind: 'm20', id: '665', ip: '192.168.123.101', user: 'user', presence: 'online' },
      { kind: 'm20', id: '738', ip: '192.168.123.103', user: 'user', presence: 'offline' },
      { kind: 'aloha', id: 'aloha', ip: '192.168.123.200', user: 'agilex', presence: 'offline' },
    ],
    sessions: [],
    flow: { setupConfirmedAt: null, plan: null, unlocked: false },
    plans: [],
    session: null,
  }
  const listeners = new Set<() => void>()
  const sent: SetupCommand[] = []
  const source: SetupSource = {
    status: () => 'open',
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    send: async (command) => {
      sent.push(command)
      return { ok: true, error: null }
    },
    terminal: () => ({ attach: () => () => undefined, input: () => undefined, resize: () => undefined }),
    planRoutes: () => Promise.reject(new Error('no plans here')),
  }
  connectSetup(source)
  render(
    <MemoryRouter>
      <SetupPage />
      <Where />
    </MemoryRouter>,
  )
  const update = (next: Partial<SetupSnapshot>) =>
    act(() => {
      snapshot = { ...snapshot, ...next }
      listeners.forEach((listener) => listener())
    })
  return { sent, update, user: userEvent.setup() }
}

const seats = () => within(screen.getByRole('region', { name: 'Robots' })).getAllByRole('listitem')

/** Where the page sent the operator */
function Where() {
  const { pathname, search } = useLocation()
  return <output aria-label="Location">{pathname + search}</output>
}
const where = () => screen.getByRole('status', { name: 'Location' })

describe('the setup lobby', () => {
  it('opens empty on Add, with the README’s robots and four seats', async () => {
    const { sent, user } = setUp([])
    expect(screen.getByRole('heading', { name: 'Add a robot' })).toBeInTheDocument()
    expect(seats()).toHaveLength(4)
    expect(within(seats()[0]).getByText('Add robot')).toBeInTheDocument()
    expect(within(seats()[0]).getByText('Next: 665 · 192.168.123.101')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add 665' }))
    expect(sent).toEqual([{ type: 'add-robot', kind: 'm20', id: '665', ip: '192.168.123.101', user: 'user', password: null }])
  })

  it('adds a robot by ID and IP, and says what is wrong first', async () => {
    const { sent, user } = setUp([robot()])
    await user.click(screen.getByRole('button', { name: /^Add robot/ }))
    const id = screen.getByRole('textbox', { name: 'Robot ID' })
    await user.clear(id)
    await user.type(id, '741')
    await user.click(screen.getByRole('button', { name: 'Add robot' }))
    expect(screen.getByText('Robot 741 is already in the lobby')).toBeInTheDocument()
    await user.clear(id)
    await user.type(id, '742')
    const ip = screen.getByRole('textbox', { name: 'Static IP' })
    await user.clear(ip)
    await user.type(ip, '192.168.123.104')
    await user.type(screen.getByLabelText('Password'), 'secret')
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
    await user.click(screen.getByRole('button', { name: 'Add robot' }))
    expect(sent).toEqual([{ type: 'add-robot', kind: 'm20', id: '742', ip: '192.168.123.104', user: 'user', password: 'secret' }])
  })

  it('logs in as agilex for the ALOHA, and shows its four steps', async () => {
    const aloha = robot({
      kind: 'aloha',
      id: 'aloha',
      ip: '192.168.123.200',
      user: 'agilex',
      setup: { state: 'running', steps: steps(['done', 'active'], ['login', 'start', 'stack', 'bridge']), startedAt: Date.now(), endedAt: null },
    })
    setUp([aloha])
    for (const title of ['Log in', 'Start ALOHA', 'Check its stack', 'Bridge']) expect(screen.getByText(title)).toBeInTheDocument()
    expect(screen.queryByText('Pull image')).toBeNull()
    expect(within(seats()[0]).getByText('SETTING UP')).toBeInTheDocument()
  })

  it('asks for the password again when the robot refuses it', async () => {
    const refused = robot({ setup: { state: 'waiting', steps: steps(['decision']), startedAt: Date.now(), endedAt: null } })
    refused.setup.steps[0].prompt = { kind: 'password', login: 'user@192.168.123.100', error: 'The robot refused the password for user@192.168.123.100' }
    const { sent, user } = setUp([refused])
    expect(screen.getByRole('button', { name: 'Log in again' })).toBeDisabled()
    await user.type(screen.getByLabelText('Password for user@192.168.123.100'), 'new one')
    await user.click(screen.getByRole('button', { name: 'Log in again' }))
    expect(sent).toEqual([{ type: 'answer', robot: '741', choice: 'retry-login', password: 'new one' }])
  })

  it('goes on to Routes once every robot is ready', async () => {
    const done = { state: 'done' as const, steps: steps(Array<SetupStepStatus>(6).fill('done')), startedAt: Date.now() - 40_000, endedAt: Date.now() }
    const { sent, update, user } = setUp([robot({ setup: done, relay: { state: 'running', since: Date.now(), rateHz: 10 } }), robot({ id: '665', ip: '192.168.123.101', presence: 'offline' })])
    const toRoutes = () => screen.getAllByRole('button', { name: /Continue to Routes/ })[0]
    expect(toRoutes()).toBeDisabled()
    expect(toRoutes()).toHaveAttribute('title', 'Not ready yet: 665')
    update({ robots: [robot({ setup: done, relay: { state: 'running', since: Date.now(), rateHz: 10 } })] })
    await user.click(toRoutes())
    expect(sent).toEqual([{ type: 'confirm-setup' }])
    expect(where()).toHaveTextContent('/routes')
  })

  it('shows a robot that does not answer faded, and cannot set it up', () => {
    setUp([robot({ presence: 'offline', lastSeen: null })])
    const seat = within(seats()[0]).getByRole('button')
    expect(seat).toHaveClass('is-offline')
    expect(within(seat).getByText('OFFLINE')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Set up 741' })).toBeDisabled()
  })

  it('shows the localize prompt and sends the operator’s answer', async () => {
    const waiting = robot({
      setup: { state: 'waiting', steps: steps(['done', 'done', 'done', 'done', 'done', 'decision']), startedAt: Date.now() - 30_000, endedAt: null },
    })
    waiting.setup.steps[5].prompt = { kind: 'localize', rviz: 'running', pose: { x: 1.25, y: -0.5, yaw: 90, at: Date.now() } }
    const { sent, user } = setUp([waiting])
    expect(within(seats()[0]).getByText('NEEDS YOU')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Localize 741 in RViz' })).toBeInTheDocument()
    expect(screen.getByText(/x 1.25 m, y -0.50 m, heading 90°/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '741 is localized' }))
    expect(sent).toEqual([{ type: 'answer', robot: '741', choice: 'localized' }])
  })

  it('shows the README commands a step types, with their outcome', async () => {
    const running = robot({ setup: { state: 'running', steps: steps(['done', 'active']), startedAt: Date.now(), endedAt: null } })
    running.setup.steps[1].commands = [
      { text: 'docker pull --platform linux/arm64 192.168.123.160:5000/m20-bridge:foxy', where: 'robot', status: 'done', note: 'up to date' },
      { text: 'docker tag  192.168.123.160:5000/m20-bridge:foxy m20-bridge:foxy', where: 'robot', status: 'running', note: null },
    ]
    setUp([running])
    const commands = within(screen.getByRole('list', { name: 'Pull image: commands' })).getAllByRole('listitem')
    expect(commands.map((li) => li.querySelector('code')?.textContent)).toEqual([
      '$ docker pull --platform linux/arm64 192.168.123.160:5000/m20-bridge:foxy',
      '$ docker tag  192.168.123.160:5000/m20-bridge:foxy m20-bridge:foxy',
    ])
    expect(within(commands[0]).getByText('up to date')).toBeInTheDocument()
    expect(commands[0]).toHaveClass('is-done')
    expect(commands[1]).toHaveClass('is-running')
    expect(screen.getByRole('button', { name: 'Stop setup' })).toBeInTheDocument()
  })

  it('shows no terminal: Open in Terminals goes to the one the current step types into', async () => {
    const running = robot({
      setup: { state: 'running', steps: steps(['done', 'done', 'done', 'active']), startedAt: Date.now(), endedAt: null },
      sessions: { robot: '741-robot-1', laptop: '741-laptop-2' },
    })
    const { user } = setUp([running])
    expect(screen.queryByRole('group', { name: /terminal/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Open in Terminals' }))
    expect(where()).toHaveTextContent('/terminals?session=741-laptop-2')
  })

  it('has no Open in Terminals before the setup opens a terminal', () => {
    setUp([robot()])
    expect(screen.queryByRole('button', { name: 'Open in Terminals' })).toBeNull()
  })

  it('sends the operator to the robot terminal to trust the registry', async () => {
    const waiting = robot({
      setup: { state: 'waiting', steps: steps(['done', 'decision']), startedAt: Date.now(), endedAt: null },
      sessions: { robot: '741-robot-1', laptop: null },
    })
    waiting.setup.steps[1].prompt = { kind: 'registry', registry: '192.168.123.160:5000', error: 'http: server gave HTTP response to HTTPS client' }
    const { sent, user } = setUp([waiting])
    expect(screen.getByRole('heading', { name: '741’s Docker does not trust this workstation’s registry' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open the robot terminal' }))
    expect(where()).toHaveTextContent('/terminals?session=741-robot-1')
    expect(sent).toEqual([])
  })

  it('offers the next robot once one is ready', async () => {
    const ready = robot({
      setup: { state: 'done', steps: steps(Array<SetupStepStatus>(6).fill('done')), startedAt: Date.now() - 40_000, endedAt: Date.now() },
      relay: { state: 'running', since: Date.now(), rateHz: 10 },
    })
    const { user } = setUp([ready])
    expect(screen.getByText('741 is ready')).toBeInTheDocument()
    expect(within(seats()[0]).getByText('READY')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Add the next robot · 665/ }))
    expect(screen.getByRole('heading', { name: 'Add a robot' })).toBeInTheDocument()
  })

  it('walks a robot into its seat when it joins', () => {
    const { update } = setUp([])
    update({ robots: [robot()] })
    expect(within(seats()[0]).getByRole('button')).toHaveClass('is-joining')
  })
})
