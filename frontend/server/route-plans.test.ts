import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RoutePlans, phaseFacts, planName } from './route-plans.ts'

/* The plans in a scratch demo/waypoints */

const ROLES = { r1: '741', r2: '665', r3: '738' }
const wp = (x: number) => ({ x, y: 0, yaw: 0 })
const COMPLETE = {
  patrol: { '741': [wp(1), wp(2), wp(3)], '665': [wp(1), wp(2), wp(3), wp(4)], '738': [wp(1), wp(2), wp(3)] },
  formation: { '741': [wp(1)], '665': [wp(2)], '738': [wp(3)] },
  sweep: { '741': [wp(1)], '665': [wp(1), wp(2)], '738': [wp(1)] },
  cordon: { '741': [wp(5)], '665': [wp(6)] },
  aloha: { aloha: [wp(4)] },
  manipulator: { poses: [{ left: [0], right: [0] }] },
}

let dir: string
let changes = 0

function plan(id: string, files: Record<string, unknown>) {
  mkdirSync(join(dir, id), { recursive: true })
  for (const [name, json] of Object.entries(files)) if (json !== undefined) writeFileSync(join(dir, id, `${name}.json`), JSON.stringify(json))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plans-'))
  changes = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the plans', () => {
  it('are the dated folders, newest first, each with what keeps it from being used', () => {
    plan('2026-10-07_15-59-41', COMPLETE)
    plan('2026-11-20_15-02-10', { ...COMPLETE, patrol: { ...COMPLETE.patrol, '665': [wp(1), wp(2)] }, aloha: undefined })
    mkdirSync(join(dir, 'not-a-plan'))
    const plans = new RoutePlans(dir, ROLES, () => changes++).list()
    expect(plans.map((p) => p.id)).toEqual(['2026-11-20_15-02-10', '2026-10-07_15-59-41'])
    expect(plans[1].problems).toEqual([])
    expect(plans[0].phases.patrol).toEqual({ robots: { '741': 3, '665': 2, '738': 3 }, problem: '665 has 2 waypoints; a patrol needs 3' })
    expect(plans[0].problems).toEqual(['Patrol: 665 has 2 waypoints; a patrol needs 3', 'No aloha.json: the ALOHA’s pose at the box'])
  })

  it('check each phase by the README’s table', () => {
    expect(phaseFacts('cordon', { '741': [wp(1)] }, ROLES, false).problem).toBe('665 has no waypoint')
    expect(phaseFacts('formation', { '741': [wp(1), wp(2)], '665': [wp(1)], '738': [wp(1)] }, ROLES, false).problem).toBe('741 has 2 waypoints; formation takes 1')
    expect(phaseFacts('sweep', null, ROLES, true).problem).toBe('not recorded')
  })

  it('start a session as a copy of the plan it is based on, and keep it only if something was recorded', () => {
    plan('2026-10-07_15-59-41', COMPLETE)
    const plans = new RoutePlans(dir, ROLES, () => changes++)
    const id = plans.newSession('2026-10-07_15-59-41', '2026-11-20_15-02-10')
    expect(id).toBe('2026-11-20_15-02-10')
    expect(JSON.parse(readFileSync(join(dir, id, 'sweep.json'), 'utf8'))).toEqual(COMPLETE.sweep)
    expect(plans.list()[0]).toMatchObject({ id, basedOn: '2026-10-07_15-59-41', recorded: [], problems: [] })
    // The same second again: the next one
    expect(plans.newSession(null, '2026-11-20_15-02-10')).toBe('2026-11-20_15-02-11')
    expect(plans.finish('2026-11-20_15-02-11')).toBe(false)
    plans.noteRecorded(id, { phase: 'sweep', robot: '738', append: true, waypoints: 2, at: 1 })
    expect(plans.finish(id)).toBe(true)
    expect(plans.list().map((p) => p.id)).toEqual([id, '2026-10-07_15-59-41'])
    expect(plans.list()[0].recorded).toEqual([{ phase: 'sweep', robot: '738', append: true, waypoints: 2, at: 1 }])
    expect(changes).toBeGreaterThan(0)
  })

  it('point current at the plan in use, and never discard it', () => {
    plan('2026-10-07_15-59-41', COMPLETE)
    plan('2026-11-20_15-02-10', COMPLETE)
    const plans = new RoutePlans(dir, ROLES, () => changes++)
    plans.use('2026-10-07_15-59-41')
    plans.use('2026-11-20_15-02-10')
    expect(lstatSync(join(dir, 'current')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(dir, 'current'))).toBe('2026-11-20_15-02-10')
    expect(plans.list().map((p) => p.current)).toEqual([true, false])
    expect(() => plans.discard('2026-11-20_15-02-10')).toThrow(/in use/)
    plans.discard('2026-10-07_15-59-41')
    expect(plans.list().map((p) => p.id)).toEqual(['2026-11-20_15-02-10'])
  })

  it('give each plan’s waypoints for its preview', () => {
    plan('2026-10-07_15-59-41', { ...COMPLETE, cordon: 'broken' })
    const routes = new RoutePlans(dir, ROLES, () => changes++).routes('2026-10-07_15-59-41')
    expect(routes.phases.formation).toEqual(COMPLETE.formation)
    expect(routes.phases.cordon).toBeNull()
    expect(() => new RoutePlans(dir, ROLES, () => undefined).routes('../etc')).toThrow(/No plan/)
  })

  it('are named in the operator’s local time', () => {
    expect(planName(Date.UTC(2026, 10, 20, 7, 2, 10), 8 * 60)).toBe('2026-11-20_15-02-10')
  })
})
