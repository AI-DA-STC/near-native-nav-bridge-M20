import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MissionSnapshot } from '../mission-stream'
import { createReplaySource, type ReplaySource } from './replay-source'

const active = (snap: MissionSnapshot) => snap.phases.find((p) => p.status === 'active')?.id ?? null
const phase = (snap: MissionSnapshot, id: string) => snap.phases.find((p) => p.id === id)!
const seconds = (ms: number) => Math.round(ms / 1000)

let source: ReplaySource
const open = (state: number) => {
  source = createReplaySource({ state })
  return source.getSnapshot()!
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-13T10:45:00'))
})
afterEach(() => {
  source?.close()
  vi.useRealTimers()
})

describe('the brief’s 16 states', () => {
  it('builds every state', () => {
    const expected: Array<[number, string, string | null, MissionSnapshot['run']['awaiting']]> = [
      [1, 'idle', 'ready', null],
      [2, 'running', 'patrol', 'instruction'],
      [3, 'running', 'formation', null],
      [4, 'running', 'approval', 'approval'],
      [5, 'running', 'formation', null],
      [6, 'running', 'sweep', null],
      [7, 'running', 'sweep', null],
      [8, 'running', 'sweep', null],
      [9, 'running', 'cordon', null],
      [10, 'running', 'inspect', null],
      [11, 'running', 'inspect', null],
      [12, 'running', 'verdict', 'verdict'],
      [13, 'ended', null, null],
      [14, 'ended', null, null],
      [15, 'ended', null, null],
      [16, 'ended', null, null],
    ]
    for (const [n, status, phaseId, awaiting] of expected) {
      const snap = open(n)
      expect([n, snap.run.status, active(snap), snap.run.awaiting]).toEqual([n, status, phaseId, awaiting])
      source.close()
    }
  })

  it('1: R2 is not connected, so the mission cannot start', () => {
    const snap = open(1)
    expect(snap.robots.r2).toMatchObject({ bridge: 'disconnected', pose: null })
    expect(snap.run.blockers.map((b) => `${b.text}: ${b.fix}`)).toEqual(['Robot 665 not connected: is its bridge running?'])
  })

  it('2: the dogs are on lap 3 of their patrol', () => {
    const snap = open(2)
    expect([snap.robots.r1, snap.robots.r2, snap.robots.r3].map((r) => r.route?.lap)).toEqual([3, 3, 3])
  })

  it('5: plan #1 was denied and #2 is generating', () => {
    const snap = open(5)
    expect(snap.plans.map((p) => [p.n, p.status])).toEqual([
      [1, 'denied'],
      [2, 'generating'],
    ])
    expect(phase(snap, 'approval').status).toBe('pending')
  })

  it('7: BOX FOUND 1:47 into the sweep, refined once', () => {
    const snap = open(7)
    expect(snap.detection).toMatchObject({ refinements: 1, confidence: 0.91, distM: 1.6 })
    expect(seconds(snap.detection!.foundAt - phase(snap, 'sweep').startedAt!)).toBe(107)
    expect(seconds(snap.serverTime - snap.run.startedAt!)).toBe(246)
  })

  it('8: no video from R3, retrying 2/3, and no finding', () => {
    const snap = open(8)
    expect(snap.camera).toMatchObject({ state: 'retrying', attempt: 2, of: 3 })
    expect(snap.detection).toBeNull()
    expect(snap.warnings.map((w) => w.text)).toEqual(["No video from R3's camera, retrying 2/3"])
  })

  it('10–11: the ALOHA docks, then opens the lid at arm pose 3', () => {
    expect(open(10).robots.aloha.docking).toMatchObject({ attempt: 2, state: 'active' })
    source.close()
    const snap = open(11)
    expect(snap.robots.aloha.arms).toMatchObject({ pose: 3, state: 'holding' })
    expect(snap.contents.state).toBe('capturing')
  })

  it('13: complete, CLEAR, 7:42 in total', () => {
    const snap = open(13)
    expect(snap.run).toMatchObject({ outcome: 'complete' })
    expect(snap.verdict?.value).toBe('clear')
    expect(seconds(snap.run.endedAt! - snap.run.startedAt!)).toBe(462)
    expect(snap.phases.every((p) => p.status === 'done')).toBe(true)
  })

  it('14: ended on ANOMALY, return to formation skipped', () => {
    const snap = open(14)
    expect(snap.run.outcome).toBe('anomaly')
    expect(phase(snap, 'return').status).toBe('skipped')
  })

  it('15: failed, the ALOHA not docked after 90 s', () => {
    const snap = open(15)
    expect(snap.run).toMatchObject({ outcome: 'failed', reason: 'ALOHA not docked after 90 s' })
    expect(phase(snap, 'inspect').status).toBe('failed')
    expect(snap.robots.aloha.docking.state).toBe('failed')
  })

  it('16: E-STOP during the sweep, R2 not confirmed', () => {
    const snap = open(16)
    expect(snap.run.outcome).toBe('estopped')
    expect(phase(snap, 'sweep').status).toBe('stopped')
    expect(snap.estop?.results.map((r) => [r.robot, r.state, r.latencyMs])).toEqual([
      ['r1', 'confirmed', 210],
      ['r2', 'unconfirmed', null],
      ['r3', 'confirmed', 340],
      ['aloha', 'confirmed', 180],
    ])
  })
})

describe('the operator’s commands', () => {
  it('sends the instruction, then the plan arrives about 5 s later', async () => {
    open(2)
    expect(await source.send({ type: 'instruction', text: '' })).toEqual({ ok: true, reason: null })
    let snap = source.getSnapshot()!
    expect(active(snap)).toBe('formation')
    expect(snap.instruction).toMatchObject({ usedDefault: true })
    expect(snap.plans.at(-1)?.status).toBe('generating')
    vi.advanceTimersByTime(5000)
    snap = source.getSnapshot()!
    expect([active(snap), snap.run.awaiting, snap.plans.at(-1)?.status]).toEqual(['approval', 'approval', 'awaiting'])
  })

  it('approving the plan starts the sweep', async () => {
    open(4)
    await source.send({ type: 'decide-plan', plan: 1, decision: 'approve' })
    const snap = source.getSnapshot()!
    expect([active(snap), snap.plans.at(-1)?.status, source.index() + 1]).toEqual(['sweep', 'executing', 6])
  })

  it('denying the plan goes back to patrol, and the next instruction asks for plan #2', async () => {
    open(4)
    await source.send({ type: 'decide-plan', plan: 1, decision: 'deny' })
    let snap = source.getSnapshot()!
    expect([active(snap), snap.run.awaiting]).toEqual(['patrol', 'instruction'])
    expect(snap.plans.map((p) => p.status)).toEqual(['denied'])
    await source.send({ type: 'instruction', text: 'Sweep zones 1 and 3 first' })
    snap = source.getSnapshot()!
    expect(snap.plans.map((p) => [p.n, p.status, p.instruction])).toEqual([
      [1, 'denied', 'Execute a systematic sweep of Zone A to scan for unattended or anomalous items'],
      [2, 'generating', 'Sweep zones 1 and 3 first'],
    ])
  })

  it('CLEAR sends the dogs back, ANOMALY ends the mission', async () => {
    open(12)
    await source.send({ type: 'verdict', value: 'clear' })
    expect(active(source.getSnapshot()!)).toBe('return')
    vi.advanceTimersByTime(6000)
    expect(source.getSnapshot()!.run.outcome).toBe('complete')
    source.close()
    open(12)
    await source.send({ type: 'verdict', value: 'anomaly' })
    expect(source.getSnapshot()!.run.outcome).toBe('anomaly')
  })

  it('refuses the verdict before the contents photo is in', async () => {
    open(11)
    expect(await source.send({ type: 'verdict', value: 'clear' })).toEqual({ ok: false, reason: 'The contents photo is not in yet' })
  })

  it('refuses Start while R2 is not connected', async () => {
    open(1)
    expect(await source.send({ type: 'start' })).toEqual({ ok: false, reason: 'Robot 665 not connected: is its bridge running?' })
  })

  it('E-STOP stops everything at once; the answers arrive, R2 never answers', async () => {
    open(7)
    await source.send({ type: 'estop' })
    let snap = source.getSnapshot()!
    expect(snap.run.outcome).toBe('estopped')
    expect(snap.estop?.results.every((r) => r.state === 'pending')).toBe(true)
    vi.advanceTimersByTime(400)
    expect(source.getSnapshot()!.estop?.results.map((r) => r.state)).toEqual(['confirmed', 'pending', 'confirmed', 'confirmed'])
    vi.advanceTimersByTime(3000)
    snap = source.getSnapshot()!
    expect(snap.estop?.results.map((r) => r.state)).toEqual(['confirmed', 'unconfirmed', 'confirmed', 'confirmed'])
    expect(snap.robots.r1.route?.state).toBe('stopped')
  })

  it('Stop mission stops gracefully; Force stop is offered 8 s later', async () => {
    open(7)
    await source.send({ type: 'stop' })
    expect(source.getSnapshot()!.run.status).toBe('stopping')
    expect((await source.send({ type: 'force-stop' })).ok).toBe(false)
    vi.advanceTimersByTime(8000)
    expect(await source.send({ type: 'force-stop' })).toEqual({ ok: true, reason: null })
    expect(source.getSnapshot()!.run).toMatchObject({ status: 'ended', outcome: 'stopped' })
  })

  it('an E-STOP cancels what the run had scheduled', async () => {
    open(2)
    await source.send({ type: 'instruction', text: '' })
    await source.send({ type: 'estop' })
    vi.advanceTimersByTime(6000)
    const snap = source.getSnapshot()!
    expect(snap.run.outcome).toBe('estopped')
    expect(snap.plans.at(-1)?.status).toBe('stopped')
  })
})
