import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import {
  connectSetup,
  type PlanPhaseFacts,
  type PlanRoutes,
  type PlanSummary,
  type RecordingFacts,
  type RobotSetupFacts,
  type RoutePhase,
  type SetupCommand,
  type SetupSnapshot,
  type SetupSource,
} from '@/shared/api'
import { RoutesPage } from '@/pages/routes'

/* The Routes screen: every robot added in Setup gets its routes, the ALOHA included; recording shows each waypoint as
 * RViz draws it, without a map */

const NOW = Date.now()
const SESSION = '2026-11-20_15-02-10'
const BASE = '2026-10-07_15-59-45'
const wp = (x: number, y = 0) => ({ x, y, yaw: 0 })

function robot(id: string, kind: 'm20' | 'aloha' = 'm20'): RobotSetupFacts {
  return {
    kind,
    id,
    ip: '192.168.123.100',
    user: kind === 'aloha' ? 'agilex' : 'user',
    addedAt: NOW - 60_000,
    presence: 'online',
    presenceSince: NOW - 60_000,
    lastSeen: NOW,
    setup: { state: 'done', steps: [], startedAt: NOW - 50_000, endedAt: NOW - 40_000 },
    relay: { state: 'running', since: NOW - 40_000, rateHz: 10 },
    nav: { state: 'running', since: null },
    lastReadyAt: NOW - 40_000,
    sessions: { robot: null, laptop: null, nav: null },
  }
}

const ROUTES: PlanRoutes = {
  id: SESSION,
  phases: {
    patrol: { '741': [wp(1), wp(2), wp(3)], '738': [wp(1), wp(2), wp(3)] },
    formation: { '741': [wp(1)], '738': [wp(3)] },
    sweep: { '741': [wp(1)], '738': [wp(5, 1), wp(6, 1)] },
    cordon: { '741': [wp(5)] },
    aloha: { aloha: [wp(4, -0.5)] },
  },
}

function phases(problem: Partial<Record<RoutePhase, string>> = {}): Record<RoutePhase, PlanPhaseFacts> {
  return Object.fromEntries(
    Object.entries(ROUTES.phases).map(([phase, routes]) => [
      phase,
      {
        robots: Object.fromEntries(Object.entries(routes ?? {}).map(([r, route]) => [r, route.length])),
        order: Object.keys(routes ?? {}).sort((a, b) => (a === '741' ? -1 : b === '741' ? 1 : 0)),
        problem: problem[phase as RoutePhase] ?? null,
      },
    ]),
  ) as Record<RoutePhase, PlanPhaseFacts>
}

function plan(id: string, over: Partial<PlanSummary> = {}): PlanSummary {
  return { id, basedOn: null, recorded: [], phases: phases(), leftOut: [], armPoses: 4, problems: [], current: false, ...over }
}

function snapshot(over: Partial<SetupSnapshot> = {}): SetupSnapshot {
  return {
    serverTime: NOW,
    robots: [robot('741'), robot('738'), robot('aloha', 'aloha')],
    suggestions: [],
    sessions: [],
    flow: { setupConfirmedAt: 1, plan: null, unlocked: false },
    plans: [plan(SESSION, { basedOn: BASE, leftOut: ['665'] }), plan(BASE, { current: true, problems: ['Sweep: 665 is in it but not added in Setup: run_demo.sh would wait for it'], phases: phases({ sweep: '665 is in it but not added in Setup: run_demo.sh would wait for it' }) })],
    session: null,
    participants: { patrol: ['741', '738'], formation: ['741', '738'], sweep: ['741', '738'], cordon: ['741', '738'], aloha: ['aloha'] },
    ...over,
  }
}

function recording(over: Partial<RecordingFacts> = {}): RecordingFacts {
  return {
    phase: 'sweep',
    robot: '738',
    append: false,
    command: `ONLY="738" WAYPOINTS=demo/waypoints/${SESSION} demo/record_waypoints.sh sweep`,
    state: 'recording',
    waypoints: [wp(7, 2)],
    message: null,
    pose: { x: 7.1, y: 2.2, yaw: 45, at: NOW },
    startedAt: NOW,
    endedAt: null,
    ...over,
  }
}

function setUp(snap: SetupSnapshot) {
  const sent: SetupCommand[] = []
  const source: SetupSource = {
    status: () => 'open',
    subscribe: () => () => undefined,
    getSnapshot: () => snap,
    send: async (command) => {
      sent.push(command)
      return { ok: true, error: null }
    },
    terminal: () => ({ attach: () => () => undefined, input: () => undefined, resize: () => undefined }),
    planRoutes: async () => ROUTES,
  }
  connectSetup(source)
  render(
    <MemoryRouter initialEntries={['/routes']}>
      <RoutesPage />
    </MemoryRouter>,
  )
  return { sent, user: userEvent.setup() }
}

const session = (over: Partial<NonNullable<SetupSnapshot['session']>> = {}): SetupSnapshot['session'] => ({
  plan: SESSION,
  basedOn: BASE,
  startedAt: NOW,
  recording: null,
  terminal: 'routes-1',
  rviz: { dogs: 'closed', aloha: 'closed' },
  ...over,
})

describe('the plans', () => {
  it('show each one’s phases, the ALOHA’s route included, and the robots a session left out', () => {
    setUp(snapshot())
    const plans = within(screen.getByRole('list', { name: 'Plans' })).getAllByRole('listitem')
    expect(plans[0]).toHaveTextContent('DonePatrolDoneFormationDoneSweepDoneCordonDoneALOHA')
    expect(plans[0]).toHaveTextContent('without 665')
    expect(plans[1]).toHaveTextContent('Sweep: 665 is in it but not added in Setup')
  })

  it('sketch the dogs’ phases and the ALOHA’s route on its own', async () => {
    setUp(snapshot())
    expect(await screen.findByRole('img', { name: /^ALOHA to the box: waypoints per robot aloha 1/ })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /^Sweep: waypoints per robot 738 2, 741 1/ })).toBeInTheDocument()
  })
})

describe('a recording session', () => {
  it('has a column for each robot added, the ALOHA last, and records the ALOHA’s route to the box', async () => {
    const { sent, user } = setUp(snapshot({ session: session() }))
    const grid = screen.getByRole('table')
    expect(within(grid).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Phase', 'R1· 741', 'R3· 738', 'ALOHA'])
    const cordon = within(grid).getByRole('row', { name: /^Cordon/ })
    // R3 records its cordon waypoint too: where it watches the box from
    expect(within(cordon).getByRole('button', { name: 'Record 738: Cordon' })).toBeInTheDocument()
    const alohaRow = within(grid).getByRole('row', { name: /^ALOHA to the box/ })
    expect(within(alohaRow).getAllByRole('button')).toHaveLength(1)
    await user.click(within(alohaRow).getByRole('button', { name: 'Record aloha: ALOHA to the box' }))
    expect(screen.getByText('RViz · ALOHA · opens when you start')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Start recording' }))
    expect(sent).toEqual([{ type: 'record-start', phase: 'aloha', robot: 'aloha', append: false }])
  })

  it('lists every waypoint as RViz draws it: the robot recorded in its colour, the others dimmed', async () => {
    setUp(snapshot({ session: session({ recording: recording(), rviz: { dogs: 'open', aloha: 'closed' } }) }))
    expect(screen.getByText('RViz · dogs · open')).toBeInTheDocument()
    // 741's saved waypoints come with the plan's routes
    await waitFor(() => expect(screen.getAllByRole('list', { name: /’s waypoints$/ })).toHaveLength(2))
    const robots = screen.getAllByRole('list', { name: /’s waypoints$/ })
    // The file's order: 741 first (blue), 738 second (orange)
    expect(screen.getByText('741').closest('li')).toHaveTextContent('blue in RViz')
    expect(screen.getByText('738').closest('li')).toHaveTextContent('orange in RViz')
    expect(robots.map((list) => list.getAttribute('aria-label'))).toEqual(['741’s waypoints', '738’s waypoints'])
    expect(within(robots[1]).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['738·1x 7.00 · y 2.00 · 0°'])
    expect(screen.getByText('Replaces its 2 saved waypoints when you save')).toBeInTheDocument()
    expect(screen.getByText('Now at x 7.10 · y 2.20 · 45°')).toBeInTheDocument()
  })

  it('numbers the new waypoints after the saved ones when adding to them, as RViz labels them', async () => {
    setUp(snapshot({ session: session({ recording: recording({ append: true }) }) }))
    await waitFor(() => expect(screen.getAllByRole('list', { name: /’s waypoints$/ })).toHaveLength(2))
    const lists = screen.getAllByRole('list', { name: /’s waypoints$/ })
    expect(within(lists[1]).getAllByRole('listitem').map((li) => li.textContent?.slice(0, 5))).toEqual(['738·1', '738·2', '738·3'])
  })

  it('opens RViz again when its window was closed', async () => {
    const { sent, user } = setUp(snapshot({ session: session({ recording: recording() }) }))
    await user.click(screen.getByRole('button', { name: 'Open RViz again' }))
    expect(sent).toEqual([{ type: 'open-rviz', which: 'dogs' }])
  })
})
