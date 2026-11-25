import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { alohaSiteOf, readBox, siteMapOf } from './mission-site.ts'

/* The box, from demo/assets/box.json as fleet_management.py and demo/find_box.py read it */

const roots: string[] = []
const rootWith = (box: unknown): string => {
  const root = mkdtempSync(join(tmpdir(), 'site-'))
  roots.push(root)
  mkdirSync(join(root, 'demo', 'assets'), { recursive: true })
  if (box !== undefined) writeFileSync(join(root, 'demo', 'assets', 'box.json'), typeof box === 'string' ? box : JSON.stringify(box))
  return root
}
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })))

describe('readBox', () => {
  it('reads the centre, the yaw in degrees and the footprint', () => {
    const box = readBox(rootWith({ x: 1.4548, y: 6.5117, z: 0.04, yaw: -0.0496, length: 0.6, width: 0.38 }))
    expect(box).toMatchObject({ x: 1.4548, y: 6.5117, w: 0.6, h: 0.38 })
    expect(box!.yaw).toBeCloseTo(-2.84, 2)
  })
  it('is null without the file, or with one it cannot read', () => {
    expect(readBox(rootWith(undefined))).toBeNull()
    expect(readBox(rootWith('{ not json'))).toBeNull()
    expect(readBox(rootWith({ x: 1, y: 2 }))).toBeNull()
  })
  it('the site carries it, and its extent takes it in', () => {
    const site = siteMapOf(null, () => null, null, { x: 9, y: -4, yaw: 0, w: 0.6, h: 0.38 })
    expect(site.box).toEqual({ x: 9, y: -4, yaw: 0, w: 0.6, h: 0.38 })
    expect(site.extent).toMatchObject({ xMax: 10.5, yMin: -5.5 })
  })
})

describe('the ALOHA’s own map', () => {
  it('its route to the box, docking at the last waypoint, on its grid; nothing of the dogs’', () => {
    const wp = (x: number, y: number, yaw = 0) => ({ x, y, yaw })
    const plan = {
      id: 'p',
      phases: { patrol: { '741': [wp(1, 1)] }, formation: null, sweep: null, cordon: null, aloha: { aloha: [wp(0, 0), wp(2, 1), wp(3, 4, Math.PI / 2)] } },
    }
    const site = alohaSiteOf(plan, { url: '/api/mission/aloha-map.png?v=1', x: -10, y: -10, w: 30, h: 25 })
    expect(site.routes.aloha).toEqual({ start: [0, 0], path: [[0, 0], [2, 1], [3, 4]], dock: { x: 3, y: 4, yaw: 90 } })
    expect(site.routes.patrol).toEqual({})
    expect(site.box).toBeNull()
    expect(site.extent).toEqual({ xMin: -10.5, xMax: 20.5, yMin: -10.5, yMax: 15.5 })
  })
  it('without a route or a grid, an empty map', () => {
    expect(alohaSiteOf(null, null)).toMatchObject({ occupancy: null, routes: { aloha: null } })
  })
})
