import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs'
import { basename, join } from 'node:path'
import type { PlanPhaseFacts, PlanRecording, PlanRoutes, PlanSummary, RoutePhase, WaypointFact } from '../src/shared/api/setup-protocol.ts'

/* The mission plans: demo/waypoints/<YYYY-MM-DD_HH-MM-SS>/, one folder per recording session, each with the six files
 * demo/run_demo.sh needs (patrol, formation, sweep, cordon, aloha, manipulator .json) and session.json (the plan it
 * started from, what was recorded over it). demo/waypoints/current points at the plan in use: the scripts default to
 * it. */

export const PHASES: readonly RoutePhase[] = ['patrol', 'formation', 'sweep', 'cordon']

export type RoleKey = 'r1' | 'r2' | 'r3'

/** Who takes part in each phase and how many waypoints each needs: the README's table, and fleet_management.py's modes
 * (a patrol loops 3 or more; single-waypoint takes exactly one) */
export const PHASE_RULES: Readonly<Record<RoutePhase, { roles: readonly RoleKey[]; min: number; max: number }>> = {
  patrol: { roles: ['r1', 'r2', 'r3'], min: 3, max: Infinity },
  formation: { roles: ['r1', 'r2', 'r3'], min: 1, max: 1 },
  sweep: { roles: ['r1', 'r2', 'r3'], min: 1, max: Infinity },
  cordon: { roles: ['r1', 'r2'], min: 1, max: 1 },
}

const PHASE_TITLE: Record<RoutePhase, string> = { patrol: 'Patrol', formation: 'Formation', sweep: 'Sweep', cordon: 'Cordon' }

/** Everything a plan folder holds for run_demo.sh, copied into a new session */
const PLAN_FILES = [...PHASES, 'aloha', 'manipulator'].map((name) => `${name}.json`)

export const PLAN_NAME = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/

interface SessionFile {
  basedOn: string | null
  startedAt: number
  finishedAt: number | null
  recorded: PlanRecording[]
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function isWaypoint(value: unknown): value is WaypointFact {
  const w = value as WaypointFact
  return typeof w === 'object' && w !== null && [w.x, w.y, w.yaw].every((n) => typeof n === 'number' && Number.isFinite(n))
}

/** A phase file: robot ID → waypoints; null when it is missing or not that shape */
function readRoutes(file: string): Record<string, WaypointFact[]> | null {
  const json = readJson(file)
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null
  const routes: Record<string, WaypointFact[]> = {}
  for (const [robot, route] of Object.entries(json)) {
    if (!Array.isArray(route) || !route.every(isWaypoint)) return null
    routes[robot] = route.map(({ x, y, yaw }) => ({ x, y, yaw }))
  }
  return routes
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** How a phase's routes measure up for the mission, robot by robot */
export function phaseFacts(phase: RoutePhase, routes: Record<string, WaypointFact[]> | null, roles: Record<RoleKey, string>, missing: boolean): PlanPhaseFacts {
  if (!routes) return { robots: {}, problem: missing ? 'not recorded' : `${phase}.json cannot be read` }
  const robots = Object.fromEntries(Object.entries(routes).map(([robot, route]) => [robot, route.length]))
  const rule = PHASE_RULES[phase]
  const problems: string[] = []
  for (const role of rule.roles) {
    const id = roles[role]
    const n = robots[id] ?? 0
    if (n === 0) problems.push(`${id} has no waypoint`)
    else if (n < rule.min) problems.push(`${id} has ${plural(n, 'waypoint')}; a patrol needs ${rule.min}`)
    else if (n > rule.max) problems.push(`${id} has ${plural(n, 'waypoint')}; ${phase} takes ${rule.max}`)
  }
  return { robots, problem: problems.length ? problems.join(' · ') : null }
}

/** A plan's name from a time, in a timezone given as its offset from UTC (the operator's, from the browser) */
export function planName(epochMs: number, utcOffsetMinutes: number): string {
  return new Date(epochMs + utcOffsetMinutes * 60_000).toISOString().slice(0, 19).replace('T', '_').replaceAll(':', '-')
}

export class RoutePlans {
  readonly dir: string
  private readonly roles: Record<RoleKey, string>
  private readonly onChange: () => void
  private cache: PlanSummary[] | null = null
  private watcher: FSWatcher | null = null
  private debounce: ReturnType<typeof setTimeout> | null = null

  constructor(dir: string, roles: Record<RoleKey, string>, onChange: () => void) {
    this.dir = dir
    this.roles = roles
    this.onChange = onChange
  }

  /** Watches the folder: recordings made by hand, and plans added or removed, show at once */
  start(): void {
    mkdirSync(this.dir, { recursive: true })
    try {
      this.watcher = watch(this.dir, { recursive: true }, () => {
        if (this.debounce) clearTimeout(this.debounce)
        this.debounce = setTimeout(() => this.invalidate(), 300)
      })
      this.watcher.on('error', () => undefined)
    } catch {
      this.watcher = null
    }
  }

  close(): void {
    this.watcher?.close()
    if (this.debounce) clearTimeout(this.debounce)
  }

  invalidate(): void {
    this.cache = null
    this.onChange()
  }

  has(id: string): boolean {
    return PLAN_NAME.test(id) && existsSync(join(this.dir, id))
  }

  /** Newest first */
  list(): PlanSummary[] {
    this.cache ??= this.scan()
    return this.cache
  }

  private scan(): PlanSummary[] {
    if (!existsSync(this.dir)) return []
    const current = this.current()
    return readdirSync(this.dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && PLAN_NAME.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse()
      .map((id) => this.summary(id, id === current))
  }

  private summary(id: string, current: boolean): PlanSummary {
    const folder = join(this.dir, id)
    const session = this.session(id)
    const phases = Object.fromEntries(
      PHASES.map((phase) => {
        const file = join(folder, `${phase}.json`)
        return [phase, phaseFacts(phase, readRoutes(file), this.roles, !existsSync(file))]
      }),
    ) as Record<RoutePhase, PlanPhaseFacts>
    const alohaJson = readJson(join(folder, 'aloha.json')) as { aloha?: unknown } | undefined
    const aloha = Array.isArray(alohaJson?.aloha) && alohaJson.aloha.length > 0 && alohaJson.aloha.every(isWaypoint)
    const poses = (readJson(join(folder, 'manipulator.json')) as { poses?: unknown } | undefined)?.poses
    const armPoses = Array.isArray(poses) ? poses.length : null
    const problems = [
      ...PHASES.filter((p) => phases[p].problem).map((p) => `${PHASE_TITLE[p]}: ${phases[p].problem}`),
      ...(aloha ? [] : ['No aloha.json: the ALOHA’s pose at the box']),
      ...(armPoses ? [] : ['No manipulator.json: the arms’ poses at the box']),
    ]
    return { id, basedOn: session?.basedOn ?? null, recorded: session?.recorded ?? [], phases, aloha, armPoses, problems, current }
  }

  private session(id: string): SessionFile | null {
    const json = readJson(join(this.dir, id, 'session.json')) as Partial<SessionFile> | undefined
    if (!json || typeof json !== 'object') return null
    return {
      basedOn: typeof json.basedOn === 'string' ? json.basedOn : null,
      startedAt: typeof json.startedAt === 'number' ? json.startedAt : 0,
      finishedAt: typeof json.finishedAt === 'number' ? json.finishedAt : null,
      recorded: Array.isArray(json.recorded) ? json.recorded : [],
    }
  }

  private writeSession(id: string, session: SessionFile): void {
    writeFileSync(join(this.dir, id, 'session.json'), `${JSON.stringify(session, null, 2)}\n`)
  }

  /** Every phase's waypoints, for the preview */
  routes(id: string): PlanRoutes {
    if (!this.has(id)) throw new Error(`No plan ${id}`)
    return {
      id,
      phases: Object.fromEntries(PHASES.map((phase) => [phase, readRoutes(join(this.dir, id, `${phase}.json`))])) as PlanRoutes['phases'],
    }
  }

  /** The plan demo/waypoints/current points at */
  current(): string | null {
    const link = join(this.dir, 'current')
    try {
      if (!lstatSync(link).isSymbolicLink()) return null
      const target = basename(readlinkSync(link))
      return PLAN_NAME.test(target) ? target : null
    } catch {
      return null
    }
  }

  /** A new plan folder named `name` (or the next free second), with `basedOn`'s files copied in */
  newSession(basedOn: string | null, name: string): string {
    if (basedOn !== null && !this.has(basedOn)) throw new Error(`No plan ${basedOn}`)
    if (!PLAN_NAME.test(name)) throw new Error(`${name} is not a plan name`)
    let id = name
    for (let bump = 1; existsSync(join(this.dir, id)); bump++) {
      const t = Date.parse(`${name.slice(0, 10)}T${name.slice(11).replaceAll('-', ':')}Z`) + bump * 1000
      id = planName(t, 0)
    }
    const folder = join(this.dir, id)
    mkdirSync(folder, { recursive: true })
    if (basedOn) {
      for (const file of PLAN_FILES) {
        const from = join(this.dir, basedOn, file)
        if (existsSync(from)) cpSync(from, join(folder, file))
      }
    }
    this.writeSession(id, { basedOn, startedAt: Date.now(), finishedAt: null, recorded: [] })
    this.invalidate()
    return id
  }

  noteRecorded(id: string, recording: PlanRecording): void {
    const session = this.session(id) ?? { basedOn: null, startedAt: Date.now(), finishedAt: null, recorded: [] }
    session.recorded.push(recording)
    this.writeSession(id, session)
    this.invalidate()
  }

  /** Ends a session: its plan stays, unless nothing was recorded into it. Returns whether it stays. */
  finish(id: string): boolean {
    const session = this.session(id)
    if (!session?.recorded.length) {
      this.discard(id)
      return false
    }
    this.writeSession(id, { ...session, finishedAt: Date.now() })
    this.invalidate()
    return true
  }

  discard(id: string): void {
    if (!this.has(id)) return
    if (this.current() === id) throw new Error(`${id} is the plan in use (demo/waypoints/current)`)
    rmSync(join(this.dir, id), { recursive: true, force: true })
    this.invalidate()
  }

  /** Points demo/waypoints/current at the plan, in one step: the scripts never see it missing */
  use(id: string): void {
    if (!this.has(id)) throw new Error(`No plan ${id}`)
    const link = join(this.dir, 'current')
    const tmp = join(this.dir, `.current-${process.pid}`)
    rmSync(tmp, { force: true })
    symlinkSync(id, tmp)
    renameSync(tmp, link)
    this.invalidate()
  }
}
