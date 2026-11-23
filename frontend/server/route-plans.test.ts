import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RoutePlans, participantsOf, phaseFacts, planName, topLevelKeys, type Lobby } from './route-plans.ts'

/* The plans in a scratch demo/waypoints, checked against the robots added in Setup */

const wp = (x: number) => ({ x, y: 0, yaw: 0 })
const COMPLETE = {
  patrol: { '741': [wp(1), wp(2), wp(3)], '665': [wp(1), wp(2), wp(3), wp(4)], '738': [wp(1), wp(2), wp(3)] },
  formation: { '741': [wp(1)], '665': [wp(2)], '738': [wp(3)] },
  sweep: { '741': [wp(1)], '665': [wp(1), wp(2)], '738': [wp(1)] },
  cordon: { '741': [wp(5)], '665': [wp(6)] },
  aloha: { aloha: [wp(4)] },
  manipulator: { poses: [{ left: [0], right: [0] }] },
}

function lobbyOf(...ids: string[]): Lobby {
  const robots = ids.map((id) => ({ id, kind: id === 'aloha' ? ('aloha' as const) : ('m20' as const) }))
  return { robots: ids, participants: participantsOf(robots, '738') }
}
const ALL = lobbyOf('741', '665', '738', 'aloha')

let dir: string
let changes = 0
let lobby: Lobby

/** As fleet_management.py writes them: robots in the order given, which JSON.stringify would not keep for "741" */
function phaseText(routes: Record<string, unknown>, order = Object.keys(routes)): string {
  return `{\n${order.map((robot) => `  ${JSON.stringify(robot)}: ${JSON.stringify(routes[robot])}`).join(',\n')}\n}`
}

function plan(id: string, files: Record<string, unknown>, order: Record<string, string[]> = {}) {
  mkdirSync(join(dir, id), { recursive: true })
  for (const [name, json] of Object.entries(files)) {
    if (json === undefined) continue
    const text = typeof json === 'object' && json !== null && name !== 'manipulator' ? phaseText(json as Record<string, unknown>, order[name]) : JSON.stringify(json)
    writeFileSync(join(dir, id, `${name}.json`), text)
  }
}

const plansHere = () => new RoutePlans(dir, () => lobby, () => changes++)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plans-'))
  changes = 0
  lobby = ALL
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('who takes part', () => {
  it('is every dog added, but the box watcher in the cordon, and the ALOHA in its route', () => {
    expect(ALL.participants).toEqual({
      patrol: ['741', '665', '738'],
      formation: ['741', '665', '738'],
      sweep: ['741', '665', '738'],
      cordon: ['741', '665'],
      aloha: ['aloha'],
    })
    expect(lobbyOf('802', 'aloha').participants.cordon).toEqual(['802'])
  })
})

describe('the plans', () => {
  it('are the dated folders, newest first, each with what keeps it from being used', () => {
    plan('2026-10-07_15-59-41', COMPLETE)
    plan('2026-11-20_15-02-10', { ...COMPLETE, patrol: { ...COMPLETE.patrol, '665': [wp(1), wp(2)] }, aloha: undefined }, { patrol: ['741', '665', '738'] })
    mkdirSync(join(dir, 'not-a-plan'))
    const plans = plansHere().list()
    expect(plans.map((p) => p.id)).toEqual(['2026-11-20_15-02-10', '2026-10-07_15-59-41'])
    expect(plans[1].problems).toEqual([])
    expect(plans[0].phases.patrol).toEqual({
      robots: { '741': 3, '665': 2, '738': 3 },
      order: ['741', '665', '738'],
      problem: '665 has 2 waypoints; a patrol needs 3',
    })
    expect(plans[0].problems).toEqual(['Patrol: 665 has 2 waypoints; a patrol needs 3', 'ALOHA to the box: not recorded'])
  })

  it('check each phase against the robots added', () => {
    const routes = (r: Record<string, ReturnType<typeof wp>[]>) => Object.entries(r)
    expect(phaseFacts('cordon', routes({ '741': [wp(1)] }), ALL, false).problem).toBe('665 has no waypoint')
    expect(phaseFacts('formation', routes({ '741': [wp(1), wp(2)], '665': [wp(1)], '738': [wp(1)] }), ALL, false).problem).toBe(
      '741 has 2 waypoints; the formation takes 1',
    )
    expect(phaseFacts('sweep', null, ALL, true).problem).toBe('not recorded')
    // 665 not added: the demo would wait for it, and nothing asks for it
    expect(phaseFacts('sweep', routes(COMPLETE.sweep), lobbyOf('741', '738'), false).problem).toBe(
      '665 is in it but not added in Setup: run_demo.sh would wait for it',
    )
    // A dog added after the plan was recorded has no route yet
    expect(phaseFacts('formation', routes(COMPLETE.formation), lobbyOf('741', '665', '738', '802'), false).problem).toBe('802 has no waypoint')
    expect(phaseFacts('aloha', routes({ aloha: [] }), ALL, false).problem).toBe('aloha has no waypoint')
  })

  it('keep each phase’s robots in the file’s order, which JSON.parse would not', () => {
    expect(topLevelKeys('{\n  "741": [{"x": 1}],\n  "665": [],\n  "a\\"b": {"738": 1}\n}')).toEqual(['741', '665', 'a"b'])
    plan('2026-10-07_15-59-41', COMPLETE, { sweep: ['738', '741', '665'] })
    expect(plansHere().list()[0].phases.sweep.order).toEqual(['738', '741', '665'])
  })

  it('start a session as a copy of the plan it is based on, and keep it only if something was recorded', () => {
    plan('2026-10-07_15-59-41', COMPLETE)
    const plans = plansHere()
    const id = plans.newSession('2026-10-07_15-59-41', '2026-11-20_15-02-10')
    expect(id).toBe('2026-11-20_15-02-10')
    expect(JSON.parse(readFileSync(join(dir, id, 'sweep.json'), 'utf8'))).toEqual(COMPLETE.sweep)
    expect(plans.list()[0]).toMatchObject({ id, basedOn: '2026-10-07_15-59-41', recorded: [], leftOut: [], problems: [] })
    // The same second again: the next one
    expect(plans.newSession(null, '2026-11-20_15-02-10')).toBe('2026-11-20_15-02-11')
    expect(plans.finish('2026-11-20_15-02-11')).toBe(false)
    plans.noteRecorded(id, { phase: 'sweep', robot: '738', append: true, waypoints: 2, at: 1 })
    expect(plans.finish(id)).toBe(true)
    expect(plans.list().map((p) => p.id)).toEqual([id, '2026-10-07_15-59-41'])
    expect(plans.list()[0].recorded).toEqual([{ phase: 'sweep', robot: '738', append: true, waypoints: 2, at: 1 }])
    expect(changes).toBeGreaterThan(0)
  })

  it('leave the robots not added out of a new session, in the file’s order, and keep that session', () => {
    plan('2026-10-07_15-59-41', COMPLETE, { patrol: ['738', '665', '741'] })
    lobby = lobbyOf('741', '738', 'aloha')
    const plans = plansHere()
    const id = plans.newSession('2026-10-07_15-59-41', '2026-11-20_15-02-10')
    const patrol = readFileSync(join(dir, id, 'patrol.json'), 'utf8')
    expect(topLevelKeys(patrol)).toEqual(['738', '741'])
    expect(JSON.parse(patrol)).toEqual({ '738': COMPLETE.patrol['738'], '741': COMPLETE.patrol['741'] })
    // As fleet_management.py writes it
    expect(patrol).toMatch(/^\{\n {2}"738": \[\n {4}\{\n {6}"x": 1,/)
    expect(JSON.parse(readFileSync(join(dir, id, 'aloha.json'), 'utf8'))).toEqual(COMPLETE.aloha)
    const summary = plans.list()[0]
    expect(summary.leftOut).toEqual(['665'])
    expect(summary.problems).toEqual([])
    // Nothing recorded, but it is the plan for these robots
    expect(plans.finish(id)).toBe(true)
  })

  it('check again when the robots added change', () => {
    plan('2026-10-07_15-59-41', COMPLETE)
    const plans = plansHere()
    expect(plans.list()[0].problems).toEqual([])
    lobby = lobbyOf('741', '665', '738')
    plans.invalidate()
    expect(plans.list()[0].problems).toEqual(['ALOHA to the box: aloha is in it but not added in Setup: run_demo.sh would wait for it'])
  })

  it('point current at the plan in use, and never discard it', () => {
    plan('2026-10-07_15-59-41', COMPLETE)
    plan('2026-11-20_15-02-10', COMPLETE)
    const plans = plansHere()
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
    const routes = plansHere().routes('2026-10-07_15-59-41')
    expect(routes.phases.formation).toEqual(COMPLETE.formation)
    expect(routes.phases.aloha).toEqual(COMPLETE.aloha)
    expect(routes.phases.cordon).toBeNull()
    expect(() => plansHere().routes('../etc')).toThrow(/No plan/)
  })

  it('are named in the operator’s local time', () => {
    expect(planName(Date.UTC(2026, 10, 20, 7, 2, 10), 8 * 60)).toBe('2026-11-20_15-02-10')
  })
})
