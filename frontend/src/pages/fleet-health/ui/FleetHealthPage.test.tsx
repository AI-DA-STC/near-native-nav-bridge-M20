import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { connectSetup, type RobotSetupFacts, type SetupSnapshot, type TerminalSessionFacts, type TerminalStream } from '@/shared/api'
import { FleetHealthPage } from '@/pages/fleet-health'

const NOW = Date.now()

function robot(kind: 'm20' | 'aloha', id: string, ip: string, addedAt: number): RobotSetupFacts {
  return {
    kind,
    id,
    ip,
    user: kind === 'aloha' ? 'agilex' : 'user',
    addedAt,
    presence: 'online',
    presenceSince: NOW,
    lastSeen: NOW,
    setup: { state: 'idle', steps: [], startedAt: null, endedAt: null },
    relay: { state: 'none', since: null, rateHz: null },
    nav: { state: 'none', since: null },
    lastReadyAt: null,
    sessions: { robot: null, laptop: null, nav: null },
  }
}

const ping = (robot: string, n: number, state: 'running' | 'exited' = 'running'): TerminalSessionFacts => ({
  id: `${robot}-ping-${n}`,
  robot,
  role: 'ping',
  state,
  startedAt: NOW,
  exitedAt: state === 'exited' ? NOW : null,
  activity: 'net_dash.py',
})

function setUp(sessions: TerminalSessionFacts[]) {
  const snapshot: SetupSnapshot = {
    serverTime: NOW,
    // In the lobby's order: 665 was added first
    robots: [robot('m20', '665', '192.168.123.101', 1), robot('m20', '741', '192.168.123.100', 2), robot('m20', '738', '192.168.123.103', 3), robot('aloha', 'aloha', '192.168.123.200', 4)],
    suggestions: [],
    sessions,
    flow: { setupConfirmedAt: null, plan: null, unlocked: false },
    plans: [],
    session: null,
    participants: { patrol: [], formation: [], sweep: [], cordon: [], aloha: [] },
  }
  connectSetup({
    status: () => 'open',
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    send: async () => ({ ok: true, error: null }),
    terminal: (): TerminalStream => ({ attach: () => () => undefined, input: () => undefined, resize: () => undefined }),
    planRoutes: () => Promise.reject(new Error('no plans here')),
  })
  render(
    <MemoryRouter initialEntries={['/fleet-health']}>
      <FleetHealthPage />
    </MemoryRouter>,
  )
}

describe('the Fleet health screen', () => {
  it('shows a ping terminal per robot in the lobby’s order, named by mission role, then the router’s', () => {
    setUp([ping('router', 5), ping('aloha', 4), ping('741', 2), ping('738', 3), ping('665', 1), { ...ping('741', 9), role: 'robot' }])
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['R2 · 665', 'R1 · 741', 'R3 · 738', 'ALOHA', 'Router'])
    expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual([
      'R2 · 665 ping terminal',
      'R1 · 741 ping terminal',
      'R3 · 738 ping terminal',
      'ALOHA ping terminal',
      'Router ping terminal',
    ])
  })

  it('marks one that ended', () => {
    setUp([ping('741', 1, 'exited')])
    expect(screen.getByText('exited · opens again shortly')).toBeInTheDocument()
  })

  it('says where they come from when there are none', () => {
    setUp([])
    expect(screen.getByText('No ping terminals: one opens for each robot added in Setup, and one for the router.')).toBeInTheDocument()
  })
})
