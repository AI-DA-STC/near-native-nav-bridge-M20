import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReplaySource, type MissionSnapshot, type ReplaySource, type SiteMap } from '@/shared/api'
import { mapSceneOf } from './map-layers'
import { isOperatorsTurn, operatorTurnOf, planViewOf } from './operator-turn'
import { phaseTrackOf } from './phase-track'
import { robotCardOf, robotStateOf } from './robot-state'
import { taskLanesOf } from './task-lanes'

/* The page's model against the replay's snapshots of the brief's 16 states */

const sources: ReplaySource[] = []
const at = (state: number): MissionSnapshot => {
  const source = createReplaySource({ state })
  sources.push(source)
  return source.getSnapshot()!
}
const siteOf = (): Promise<SiteMap> => createReplaySource().siteMap()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-13T10:45:00'))
})
afterEach(() => {
  sources.splice(0).forEach((s) => s.close())
  vi.useRealTimers()
})

describe('phase track', () => {
  it('7: the sweep is under way, BOX FOUND 1:47 in; done phases show their durations', () => {
    const { phases } = phaseTrackOf(at(7))
    const phase = (id: string) => phases.find((p) => p.id === id)!
    expect(phase('sweep')).toMatchObject({ status: 'active', time: '1:55', finding: { label: 'BOX FOUND', at: '1:47' } })
    expect(phase('sweep').sub).toEqual([
      { robot: 'r1', text: 'WP 3/3' },
      { robot: 'r2', text: 'WP 3/3' },
      { robot: 'r3', text: 'WP 3/3' },
    ])
    expect([phase('patrol').time, phase('formation').time, phase('approval').time]).toEqual(['1:28', '0:06', '0:37'])
    expect(phase('approval').note).toBe('Approved')
  })

  it('2: patrol, lap 3, and the instruction is the operator’s', () => {
    const patrol = phaseTrackOf(at(2)).phases.find((p) => p.id === 'patrol')!
    expect(patrol.turn).toBe('Your instruction')
    expect(patrol.sub).toEqual(['r1', 'r2', 'r3'].map((robot) => ({ robot, text: 'lap 3' })))
  })

  it('5: a denied plan loops back to patrol, with its count', () => {
    const track = phaseTrackOf(at(5))
    expect(track.loops).toEqual([{ from: 'approval', to: 'patrol', count: 1 }])
    expect(track.phases.find((p) => p.id === 'approval')?.note).toBe('Denied ×1')
    expect(track.phases.find((p) => p.id === 'formation')?.sub).toBe('Generating plan #2…')
  })

  it('1: bring-up, with what is missing', () => {
    const ready = phaseTrackOf(at(1)).phases[0]
    expect(ready).toMatchObject({ status: 'active', turn: null, sub: 'Fleet 2/3 · Positions 2/3 · ALOHA ready' })
  })

  it('13–15: the total, the verdict, a skipped and a failed phase', () => {
    const complete = phaseTrackOf(at(13))
    expect(complete.total).toBe('7:42')
    expect(complete.phases.find((p) => p.id === 'verdict')?.note).toEqual({ verdict: 'clear' })
    const anomaly = phaseTrackOf(at(14))
    expect(anomaly.phases.find((p) => p.id === 'return')?.status).toBe('skipped')
    expect(anomaly.phases.find((p) => p.id === 'verdict')?.note).toEqual({ verdict: 'anomaly' })
    const failed = phaseTrackOf(at(15)).phases.find((p) => p.id === 'inspect')
    expect(failed).toMatchObject({ status: 'failed', note: 'ALOHA not docked after 90 s' })
  })
})

describe('task lanes', () => {
  const cell = (snap: MissionSnapshot, robot: string, phase: string) => taskLanesOf(snap).find((l) => l.robot === robot)!.cells[phase as 'sweep']
  it('7: the ALOHA idles through the sweep and waits on the cordon; the dogs sweep', () => {
    const snap = at(7)
    expect(cell(snap, 'aloha', 'sweep').state).toBe('idle')
    expect(cell(snap, 'aloha', 'cordon').state).toBe('wait')
    expect(cell(snap, 'r1', 'sweep')).toMatchObject({ state: 'active', text: 'Sweep zone 1' })
    expect(cell(snap, 'r1', 'sweep').progress).toBeGreaterThan(0.5)
    expect(cell(snap, 'r1', 'patrol').state).toBe('done')
  })
  it('1: R2’s bring-up failed; 15: the ALOHA’s inspection failed, not the dogs’', () => {
    expect(cell(at(1), 'r2', 'ready').state).toBe('failed')
    const snap = at(15)
    expect(cell(snap, 'aloha', 'inspect').state).toBe('failed')
    expect(cell(snap, 'r1', 'inspect').state).toBe('done')
  })
})

describe('robot state words', () => {
  it('by priority: not connected, no position, stale', () => {
    const snap = at(7)
    const r1 = snap.robots.r1
    const withR1 = (patch: Partial<typeof r1>): MissionSnapshot => ({ ...snap, robots: { ...snap.robots, r1: { ...r1, ...patch } } })
    expect(robotStateOf('r1', withR1({ bridge: 'disconnected' }))).toMatchObject({ word: 'NOT CONNECTED', tone: 'fault' })
    expect(robotStateOf('r1', withR1({ pose: null }))).toMatchObject({ word: 'NO POSITION', tone: 'warn' })
    expect(robotStateOf('r1', withR1({ pose: { ...r1.pose!, at: snap.serverTime - 4000 } }))).toMatchObject({ word: 'STALE 4 s', tone: 'warn' })
  })
  it('follows the mission: patrol laps, docking, the lid', () => {
    expect(robotStateOf('r1', at(2)).word).toBe('PATROLLING · LAP 3')
    expect(robotStateOf('r2', at(1))).toMatchObject({ word: 'NOT CONNECTED', task: 'Is its bridge running?' })
    expect(robotStateOf('aloha', at(10)).word).toBe('DOCKING 2/3')
    expect(robotStateOf('aloha', at(11))).toMatchObject({ word: 'ARMS 3/5 · LID OPEN', task: 'Holding 5 s for the photo' })
    expect(robotStateOf('r3', at(9)).word).toBe('WATCHING ITEM')
  })
  it('16: a robot that never confirmed the E-STOP is not shown as stopped', () => {
    const snap = at(16)
    expect(robotStateOf('r1', snap)).toMatchObject({ word: 'STOPPED', task: 'Stopped by E-STOP · confirmed 210 ms' })
    expect(robotStateOf('r2', snap)).toMatchObject({ word: 'E-STOP NOT CONFIRMED', tone: 'fault' })
  })
  it('a card: its goal, the distance to it, its waypoints', () => {
    const card = robotCardOf('r1', at(7))
    expect(card.goal).toBe('WP 3')
    expect(card.dist).toBeGreaterThan(0)
    expect(card.progress?.max).toBe(3)
    expect(robotCardOf('aloha', at(7)).docking).toBeNull()
    expect(robotCardOf('aloha', at(11)).arms).toMatchObject({ pose: 3, detail: 'pose 3/5 · lid open' })
  })
})

describe('map layers', () => {
  it('2: the patrol loops; 4: the plan waiting for approval as a dashed preview', async () => {
    const site = await siteOf()
    expect(mapSceneOf(at(2), site).routes.filter((r) => r.kind === 'patrol')).toHaveLength(3)
    expect(mapSceneOf(at(4), site).routes.filter((r) => r.kind === 'preview')).toHaveLength(3)
  })
  it('7: the sweep routes with their targets, the box tightened to 0.35 m, R3’s sight line', async () => {
    const scene = mapSceneOf(at(7), await siteOf())
    expect(scene.routes.map((r) => [r.kind, r.current])).toEqual([
      ['sweep', 3],
      ['sweep', 3],
      ['sweep', 3],
    ])
    expect(scene.box).toMatchObject({ halo: 0.35, label: 'BOX 91 %', state: 'refined' })
    expect(scene.sight).toEqual({ from: 'r3' })
    expect(scene.zones.every((z) => z.active)).toBe(true)
  })
  it('11: focused on zone 3, with the ALOHA’s path and dock pose', async () => {
    const scene = mapSceneOf(at(11), await siteOf())
    expect(scene.focus).not.toBeNull()
    expect(scene.dock).toMatchObject({ docked: true })
    expect(scene.routes.some((r) => r.kind === 'aloha')).toBe(true)
  })
})

describe('the Operator panel', () => {
  it('follows the mission, and is the one hot panel exactly when it is the operator’s turn', () => {
    const kinds = Array.from({ length: 16 }, (_, i) => {
      const snap = at(i + 1)
      const turn = operatorTurnOf(snap)
      const operatorsTurn = snap.run.awaiting !== null || (snap.run.status === 'idle' && snap.run.blockers.length === 0)
      expect(isOperatorsTurn(turn)).toBe(operatorsTurn)
      return turn.kind
    })
    expect(kinds).toEqual([
      'start',
      'instruction',
      'generating',
      'approval',
      'generating',
      'running',
      'running',
      'running',
      'running',
      'running',
      'running',
      'verdict',
      'outcome',
      'outcome',
      'outcome',
      'outcome',
    ])
  })
  it('1: Start waits on the missing bring-up steps', () => {
    const turn = operatorTurnOf(at(1))
    expect(turn).toMatchObject({ kind: 'start', hot: false })
    if (turn.kind === 'start') expect(turn.steps.map((s) => s.status)).toEqual(['failed', 'failed', 'done', 'done'])
  })
  it('7: the running plan marks each robot’s steps', () => {
    const snap = at(7)
    const plan = planViewOf(snap.plans[snap.plans.length - 1], snap)
    const r3 = plan.steps.find((s) => s.robot === 'r3')!.items.map((i) => i.status)
    expect(r3).toEqual(['active', 'done', 'pending', 'pending', 'pending'])
    expect(operatorTurnOf(snap)).toMatchObject({ eyebrow: 'Next decision · Verdict', question: 'Sweep running: R3 has found the box.' })
  })
  it('13: the outcome, with the total and where the box was', () => {
    const turn = operatorTurnOf(at(13))
    expect(turn).toMatchObject({ kind: 'outcome', outcome: 'complete', verdict: 'clear', total: '7:42' })
    if (turn.kind === 'outcome') expect(turn.facts[0]).toEqual({ label: 'Box at', value: '(4.05, −1.70)', mono: true })
  })
})
