import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectMission, connectSetup, createReplaySource, type ReplaySource, type SetupSnapshot, type SetupSource } from '@/shared/api'
import { routes } from './router'

/* The whole app on the scenario replay: each of the brief's 16 states, and the operator's flows */

let source: ReplaySource

/** The setup server's facts: Setup and Routes confirmed unless said otherwise */
function setupFacts(flow: Partial<SetupSnapshot['flow']> = {}): SetupSnapshot {
  return {
    serverTime: Date.now(),
    robots: [],
    suggestions: [],
    sessions: [],
    flow: { setupConfirmedAt: 1, plan: { id: '2026-10-07_15-59-41', confirmedAt: 2 }, unlocked: false, ...flow },
    plans: [],
    session: null,
    participants: { patrol: [], formation: [], sweep: [], cordon: [], aloha: [] },
  }
}

function connectSetupFacts(snapshot: SetupSnapshot) {
  const setup: SetupSource = {
    status: () => 'open',
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    send: async () => ({ ok: true, error: null }),
    terminal: () => ({ attach: () => () => undefined, input: () => undefined, resize: () => undefined }),
    planRoutes: () => Promise.reject(new Error('no plans here')),
  }
  connectSetup(setup)
}

function renderApp(state: number, path = '/mission', setup = setupFacts()) {
  source = createReplaySource({ state })
  connectMission(source)
  connectSetupFacts(setup)
  render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />)
  return userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) })
}

const snapshot = () => source.getSnapshot()!
const hotPanels = () => document.querySelectorAll('.cc-panel.is-hot').length

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-10-13T10:45:00'))
})
afterEach(() => {
  source.close()
  vi.useRealTimers()
})

describe('each of the brief’s states', () => {
  const facts: Array<[number, () => void]> = [
    [
      1,
      () => {
        expect(screen.getByText('NOT READY')).toBeInTheDocument()
        expect(screen.getByText('Robot 665 not connected: is its bridge running?')).toBeInTheDocument()
        screen.getAllByRole('button', { name: /^Start mission/ }).forEach((button) => expect(button).toBeDisabled())
      },
    ],
    [2, () => expect(screen.getByRole('textbox', { name: 'Instruction' })).toHaveAttribute('placeholder', 'Execute a systematic sweep of Zone A to scan for unattended or anomalous items')],
    [3, () => expect(screen.getAllByText('Generating plan…').length).toBeGreaterThan(0)],
    [4, () => expect(screen.getByRole('button', { name: /^Approve plan/ })).toBeEnabled()],
    [5, () => expect(screen.getAllByText('Generating plan #2…').length).toBeGreaterThan(0)],
    [6, () => expect(screen.getAllByText('Sweep running: every robot sweeps its zone.').length).toBeGreaterThan(0)],
    [7, () => expect(screen.getByText('refined ×1')).toBeInTheDocument()],
    [8, () => expect(screen.getAllByText(/No video from R3's camera, retrying 2\/3/).length).toBeGreaterThan(0)],
    [9, () => expect(screen.getByText('Cordon: R1 and R2 are closing off zone 3.')).toBeInTheDocument()],
    [10, () => expect(screen.getAllByText('DOCKING 2/3').length).toBeGreaterThan(0)],
    [11, () => expect(screen.getAllByText('ARMS 3/5 · PHOTOS').length).toBeGreaterThan(0)],
    [12, () => expect(screen.getByRole('button', { name: 'ANOMALY' })).toBeEnabled()],
    [13, () => expect(screen.getByText('Mission complete')).toBeInTheDocument()],
    [14, () => expect(screen.getByText('Mission ended')).toBeInTheDocument()],
    [15, () => expect(screen.getByText('Mission failed')).toBeInTheDocument()],
    [
      16,
      () => {
        expect(screen.getByRole('alert')).toHaveTextContent('E-STOP SENT')
        expect(screen.getByRole('alert')).toHaveTextContent('NOT CONFIRMED')
      },
    ],
  ]

  it.each(facts)('state %i shows its key fact, and one hot panel only when it is the operator’s turn', (state, check) => {
    renderApp(state)
    check()
    expect(hotPanels()).toBe([2, 4, 12].includes(state) ? 1 : 0)
  })
})

describe('the operator’s flows', () => {
  it('Approve plan has a confirm step: Esc cancels, Enter confirms, the sweep starts', async () => {
    const user = renderApp(4)
    await user.click(screen.getByRole('button', { name: /^Approve plan/ }))
    expect(screen.getByRole('dialog', { name: 'Approve plan SR2-01?' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(snapshot().run.awaiting).toBe('approval')

    await user.click(screen.getByRole('button', { name: /^Approve plan/ }))
    await user.keyboard('{Enter}')
    expect(snapshot().phases.find((p) => p.id === 'sweep')?.status).toBe('active')
    // the toast confirms it (the timeline records it too)
    expect(await within(document.querySelector<HTMLElement>('.cc-toasts')!).findByText('Plan SR2-01 approved')).toBeInTheDocument()
  })

  it('Deny goes back to patrol, and the plan stays in the history as Denied', async () => {
    const user = renderApp(4)
    await user.click(screen.getByRole('button', { name: 'Deny' }))
    expect(snapshot().run.awaiting).toBe('instruction')
    await user.click(screen.getByRole('radio', { name: 'Plans' }))
    const history = document.querySelector<HTMLElement>('.cc-history')!
    expect(within(history).getByText('Denied')).toBeInTheDocument()
  })

  it('an empty instruction sends the default one', async () => {
    const user = renderApp(2)
    await user.click(screen.getByRole('textbox', { name: 'Instruction' }))
    await user.keyboard('{Enter}')
    expect(snapshot().instruction).toMatchObject({ usedDefault: true })
    expect(screen.getAllByText('Instruction sent (default)').length).toBeGreaterThan(0)
  })

  it('E-STOP fires on one click, with no confirm step, and the banner reports each robot', async () => {
    const user = renderApp(7)
    await user.click(screen.getByRole('button', { name: 'E-STOP' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(snapshot().run.outcome).toBe('estopped')
    expect(screen.getByRole('alert')).toHaveTextContent('E-STOP SENT')
    await act(async () => {
      vi.advanceTimersByTime(3500)
    })
    expect(screen.getByRole('alert')).toHaveTextContent('3/4 confirmed')
  })

  it('E-STOP is on the Command center only: setting up moves no robot', async () => {
    const user = renderApp(7, '/setup')
    expect(screen.queryByRole('button', { name: 'E-STOP' })).toBeNull()
    await user.click(screen.getByRole('tab', { name: 'Terminals' }))
    expect(screen.queryByRole('button', { name: 'E-STOP' })).toBeNull()
    await user.click(screen.getByRole('tab', { name: 'Command center' }))
    expect(screen.getByRole('button', { name: 'E-STOP' })).toBeEnabled()
  })

  it('Stop mission has a confirm step, and becomes Force stop 8 s later', async () => {
    const user = renderApp(7)
    await user.click(screen.getByRole('button', { name: /^Stop mission/ }))
    const stop = screen.getByRole('dialog', { name: 'Stop the mission?' })
    await user.click(within(stop).getByRole('button', { name: /^Stop mission/ }))
    expect(snapshot().run.status).toBe('stopping')
    expect(screen.getByRole('button', { name: /^Stopping/ })).toBeDisabled()

    // 8 s after Stop (the click itself took a few real milliseconds), before the graceful stop ends at 10 s
    await act(async () => {
      vi.advanceTimersByTime(9000)
    })
    await user.click(screen.getByRole('button', { name: /^Force stop/ }))
    const force = screen.getByRole('dialog', { name: 'Force stop the mission?' })
    await user.click(within(force).getByRole('button', { name: /^Force stop/ }))
    expect(snapshot().run).toMatchObject({ status: 'ended', outcome: 'stopped' })
  })

  it('the box pops up enlarged the moment R3 finds it; closed, it stays in the card, whose image opens it again', async () => {
    const user = renderApp(6)
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => source.go(source.states.findIndex((s) => s.n === 7)))
    const popup = screen.getByRole('dialog', { name: /^R3 · BOX FOUND · / })
    await user.click(within(popup).getByRole('button', { name: /^Close/ }))
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => vi.advanceTimersByTime(3000)) // the facts go on updating: it does not pop up again
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.click(screen.getByRole('img', { name: 'Snapshot of the box' }))
    expect(screen.getByRole('dialog', { name: /^R3 · BOX FOUND · / })).toBeInTheDocument()
  })

  it('a box found before the page opened shows in its card only', () => {
    renderApp(7)
    expect(screen.getByRole('img', { name: 'Snapshot of the box' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('ANOMALY has a confirm step and ends the mission, never as a failure', async () => {
    const user = renderApp(12)
    await user.click(screen.getByRole('button', { name: 'ANOMALY' }))
    const dialog = screen.getByRole('dialog', { name: 'Mark the contents ANOMALY?' })
    await user.click(within(dialog).getByRole('button', { name: /^Mark ANOMALY/ }))
    expect(snapshot().run.outcome).toBe('anomaly')
    expect(screen.getByText('ENDED')).toBeInTheDocument()
    expect(screen.queryByText('ENDED (FAILED)')).toBeNull()
  })
})

describe('the way through the console', () => {
  it('opens on the landing page; Launch goes to the step not confirmed yet', async () => {
    const user = renderApp(1, '/', setupFacts({ setupConfirmedAt: null, plan: null }))
    expect(screen.getByRole('heading', { name: 'Command Center' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'ST Engineering' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'NEAR LAB' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Launch' }))
    expect(screen.getByRole('tab', { name: 'Setup' })).toHaveAttribute('aria-selected', 'true')
  })

  it('locks the Command center until Setup and Routes are confirmed, keeps Fleet health open, and has no Log', () => {
    renderApp(1, '/mission', setupFacts({ plan: null }))
    // Sent on to the step that is missing
    expect(screen.getByRole('tab', { name: 'Routes' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Command center' })).toBeDisabled()
    expect(screen.getByRole('tab', { name: 'Command center' })).toHaveAttribute('title', 'Confirm Setup and Routes first')
    expect(screen.getByRole('tab', { name: 'Fleet health' })).toBeEnabled()
    expect(screen.queryByRole('tab', { name: 'Log' })).toBeNull()
  })

  it('opens the Command center once both are confirmed', () => {
    renderApp(1, '/mission')
    expect(screen.getByRole('tab', { name: 'Command center' })).toBeEnabled()
    expect(screen.getByRole('tab', { name: 'Fleet health' })).toBeEnabled()
  })
})
