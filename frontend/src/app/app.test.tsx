import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectMission, createReplaySource, type ReplaySource } from '@/shared/api'
import { routes } from './router'

/* The whole app on the scenario replay: each of the brief's 16 states, and the operator's flows */

let source: ReplaySource

function renderApp(state: number) {
  source = createReplaySource({ state })
  connectMission(source)
  render(<RouterProvider router={createMemoryRouter(routes)} />)
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
    [6, () => expect(screen.getByText('searching for the box…')).toBeInTheDocument()],
    [7, () => expect(screen.getByText('refined ×1')).toBeInTheDocument()],
    [8, () => expect(document.querySelector('.cc-cam__msg')).toHaveTextContent('No video from R3, retrying 2/3')],
    [9, () => expect(screen.getByText('Cordon: R1 and R2 are closing off zone 3.')).toBeInTheDocument()],
    [10, () => expect(screen.getAllByText('DOCKING 2/3').length).toBeGreaterThan(0)],
    [11, () => expect(screen.getAllByText('ARMS 3/5 · LID OPEN').length).toBeGreaterThan(0)],
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
