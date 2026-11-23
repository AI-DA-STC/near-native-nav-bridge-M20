import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { connectSetup, type SetupSnapshot, type SetupSource, type TerminalStream } from '@/shared/api'
import { TerminalsPage } from '@/pages/terminals'

const NOW = Date.now()

function setUp(snapshot: SetupSnapshot, path = '/terminals') {
  const typed: Array<[string, string]> = []
  const source: SetupSource = {
    status: () => 'open',
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    send: async () => ({ ok: true, error: null }),
    terminal: (session): TerminalStream => ({
      attach: () => () => undefined,
      input: (data) => typed.push([session, data]),
      resize: () => undefined,
    }),
    planRoutes: () => Promise.reject(new Error('no plans here')),
  }
  connectSetup(source)
  render(
    <MemoryRouter initialEntries={[path]}>
      <TerminalsPage />
    </MemoryRouter>,
  )
  return { typed, user: userEvent.setup() }
}

const snapshot: SetupSnapshot = {
  serverTime: NOW,
  robots: [],
  suggestions: [],
  sessions: [
    { id: '741-laptop-2', robot: '741', role: 'laptop', state: 'running', startedAt: NOW, exitedAt: null, activity: 'rviz2' },
    { id: '741-robot-1', robot: '741', role: 'robot', state: 'running', startedAt: NOW, exitedAt: null, activity: 'ros2 launch nav_cmd_bridge relays.launch.py' },
    { id: '665-robot-3', robot: '665', role: 'robot', state: 'exited', startedAt: NOW, exitedAt: NOW, activity: 'exited with code 0' },
    { id: 'routes-4', robot: 'routes', role: 'routes', state: 'running', startedAt: NOW, exitedAt: null, activity: 'record_waypoints.sh sweep · 738' },
  ],
  flow: { setupConfirmedAt: null, plan: null, unlocked: false },
  plans: [],
  session: null,
  participants: { patrol: [], formation: [], sweep: [], cordon: [], aloha: [] },
}

describe('the Terminals screen', () => {
  it('lists each robot’s terminals, the robot’s first, and opens on a relay', () => {
    setUp(snapshot)
    const robot741 = screen.getByRole('region', { name: 'Robot 741' })
    expect(within(robot741).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Robot · relayrunningros2 launch nav_cmd_bridge relays.launch.py',
      'Laptoprunningrviz2',
    ])
    expect(screen.getByRole('group', { name: '741 · Robot · relay terminal' })).toBeInTheDocument()
  })

  it('lists the Routes recorder after the robots', () => {
    setUp(snapshot, '/terminals?session=routes-4')
    expect(within(screen.getByRole('region', { name: 'Robot routes' })).getByRole('button').textContent).toBe('Recorderrunningrecord_waypoints.sh sweep · 738')
    expect(screen.getByRole('group', { name: 'Routes · Recorder terminal' })).toBeInTheDocument()
  })

  it('opens the session it is linked to, and interrupts it with Ctrl+C', async () => {
    const { typed, user } = setUp(snapshot, '/terminals?session=741-laptop-2')
    expect(screen.getByRole('group', { name: '741 · Laptop terminal' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Ctrl+C' }))
    expect(typed).toEqual([['741-laptop-2', '\x03']])
  })

  it('says where terminals come from when there are none', () => {
    setUp({ ...snapshot, sessions: [] })
    expect(screen.getByText('No terminals yet: each robot’s open when its setup starts.')).toBeInTheDocument()
  })
})
