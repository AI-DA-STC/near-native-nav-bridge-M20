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
 * it. A plan is checked against the robots added in Setup: run_demo.sh waits for every robot a phase names. */

/** run_demo.sh's order; aloha is the ALOHA's route to the box (aloha.json), which aloha/run_aloha.sh drives */
export const PHASES: readonly RoutePhase[] = ['patrol', 'formation', 'sweep', 'cordon', 'aloha']

/** The phases fleet_management.py runs with the dogs */
export const DOG_PHASES: readonly RoutePhase[] = ['patrol', 'formation', 'sweep', 'cordon']

/** How many waypoints each robot needs: fleet_management.py's modes (a patrol loops 3 or more; single-waypoint takes
 * exactly one), as record_waypoints.sh runs them */
export const PHASE_RULES: Readonly<Record<RoutePhase, { min: number; max: number }>> = {
  patrol: { min: 3, max: Infinity },
  formation: { min: 1, max: 1 },
  sweep: { min: 1, max: Infinity },
  cordon: { min: 1, max: 1 },
  aloha: { min: 1, max: Infinity },
}

export const PHASE_TITLE: Readonly<Record<RoutePhase, string>> = {
  patrol: 'Patrol',
  formation: 'Formation',
  sweep: 'Sweep',
  cordon: 'Cordon',
  aloha: 'ALOHA to the box',
}

/** Everything a plan folder holds for run_demo.sh, copied into a new session */
const PLAN_FILES = [...PHASES, 'manipulator'].map((name) => `${name}.json`)

/** The robots added in Setup, which the plans are checked against */
export interface Lobby {
  robots: string[]
  participants: Record<RoutePhase, string[]>
}

/** Who takes part in each phase, from the robots added (in the lobby's order): every M20 in the dogs' phases (in the
 * cordon R3's waypoint is where it watches the box), the ALOHA in its route */
export function participantsOf(robots: ReadonlyArray<{ id: string; kind: 'm20' | 'aloha' }>): Record<RoutePhase, string[]> {
  const dogs = robots.filter((r) => r.kind === 'm20').map((r) => r.id)
  return {
    patrol: dogs,
    formation: dogs,
    sweep: dogs,
    cordon: dogs,
    aloha: robots.filter((r) => r.kind === 'aloha').map((r) => r.id),
  }
}

/** A JSON object's keys in the order the text has them: JSON.parse puts integer-like keys ("741", "665") first, in
 * ascending order, and fleet_management.py colours each robot by its place in the file */
export function topLevelKeys(text: string): string[] {
  const keys: string[] = []
  let i = text.indexOf('{')
  if (i < 0) return keys
  let depth = 0
  let expectKey = true
  for (i++; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      let end = i + 1
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1
      if (depth === 0 && expectKey) {
        keys.push(JSON.parse(text.slice(i, end + 1)) as string)
        expectKey = false
      }
      i = end
    } else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      if (depth === 0) break
      depth--
    } else if (c === ',' && depth === 0) expectKey = true
  }
  return keys
}

/** A phase file written the way fleet_management.py writes it (json.dump, indent 2), robots in the order given */
function phaseJson(entries: ReadonlyArray<[string, WaypointFact[]]>): string {
  const body = entries.map(([robot, route]) => `  ${JSON.stringify(robot)}: ${JSON.stringify(route, null, 2).replaceAll('\n', '\n  ')}`)
  return `{\n${body.join(',\n')}\n}`
}

export const PLAN_NAME = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/

interface SessionFile {
  basedOn: string | null
  startedAt: number
  finishedAt: number | null
  recorded: PlanRecording[]
  /** Robots not copied from basedOn: they were not added in Setup */
  leftOut: string[]
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

/** A phase file's routes, robot by robot in the file's order; null when it is missing or not that shape */
function readRoutes(file: string): Array<[string, WaypointFact[]]> | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null
  const routes = json as Record<string, unknown>
  const entries: Array<[string, WaypointFact[]]> = []
  for (const robot of topLevelKeys(text)) {
    const route = routes[robot]
    if (!Array.isArray(route) || !route.every(isWaypoint)) return null
    entries.push([robot, route.map(({ x, y, yaw }) => ({ x, y, yaw }))])
  }
  return entries.length === Object.keys(routes).length ? entries : null
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** How a phase's routes measure up for the mission with the robots added: each one taking part has the waypoints it
 * needs, and the file names no robot that was not added (run_demo.sh would wait for it) */
export function phaseFacts(phase: RoutePhase, routes: ReadonlyArray<[string, WaypointFact[]]> | null, lobby: Lobby, missing: boolean): PlanPhaseFacts {
  if (!routes) return { robots: {}, order: [], problem: missing ? 'not recorded' : `${phase}.json cannot be read` }
  const robots = Object.fromEntries(routes.map(([robot, route]) => [robot, route.length]))
  const rule = PHASE_RULES[phase]
  const problems: string[] = []
  for (const id of lobby.participants[phase]) {
    const n = robots[id] ?? 0
    if (n === 0) problems.push(`${id} has no waypoint`)
    else if (n < rule.min) problems.push(`${id} has ${plural(n, 'waypoint')}; a patrol needs ${rule.min}`)
    else if (n > rule.max) problems.push(`${id} has ${plural(n, 'waypoint')}; the ${phase} takes ${rule.max}`)
  }
  for (const [id] of routes) {
    if (!lobby.robots.includes(id)) problems.push(`${id} is in it but not added in Setup: run_demo.sh would wait for it`)
  }
  if (!routes.length && !lobby.participants[phase].length) problems.push('no robot takes part')
  return { robots, order: routes.map(([robot]) => robot), problem: problems.length ? problems.join(' · ') : null }
}

/** A plan's name from a time, in a timezone given as its offset from UTC (the operator's, from the browser) */
export function planName(epochMs: number, utcOffsetMinutes: number): string {
  return new Date(epochMs + utcOffsetMinutes * 60_000).toISOString().slice(0, 19).replace('T', '_').replaceAll(':', '-')
}

export class RoutePlans {
  readonly dir: string
  private readonly lobby: () => Lobby
  private readonly onChange: () => void
  private cache: PlanSummary[] | null = null
  private watcher: FSWatcher | null = null
  private debounce: ReturnType<typeof setTimeout> | null = null

  constructor(dir: string, lobby: () => Lobby, onChange: () => void) {
    this.dir = dir
    this.lobby = lobby
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
    const lobby = this.lobby()
    return readdirSync(this.dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && PLAN_NAME.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse()
      .map((id) => this.summary(id, id === current, lobby))
  }

  private summary(id: string, current: boolean, lobby: Lobby): PlanSummary {
    const folder = join(this.dir, id)
    const session = this.session(id)
    const phases = Object.fromEntries(
      PHASES.map((phase) => {
        const file = join(folder, `${phase}.json`)
        return [phase, phaseFacts(phase, readRoutes(file), lobby, !existsSync(file))]
      }),
    ) as Record<RoutePhase, PlanPhaseFacts>
    const poses = (readJson(join(folder, 'manipulator.json')) as { poses?: unknown } | undefined)?.poses
    const armPoses = Array.isArray(poses) ? poses.length : null
    const problems = [
      ...PHASES.filter((p) => phases[p].problem).map((p) => `${PHASE_TITLE[p]}: ${phases[p].problem}`),
      ...(armPoses ? [] : ['No manipulator.json: the arms’ poses at the box']),
    ]
    return { id, basedOn: session?.basedOn ?? null, recorded: session?.recorded ?? [], phases, leftOut: session?.leftOut ?? [], armPoses, problems, current }
  }

  private session(id: string): SessionFile | null {
    const json = readJson(join(this.dir, id, 'session.json')) as Partial<SessionFile> | undefined
    if (!json || typeof json !== 'object') return null
    return {
      basedOn: typeof json.basedOn === 'string' ? json.basedOn : null,
      startedAt: typeof json.startedAt === 'number' ? json.startedAt : 0,
      finishedAt: typeof json.finishedAt === 'number' ? json.finishedAt : null,
      recorded: Array.isArray(json.recorded) ? json.recorded : [],
      leftOut: Array.isArray(json.leftOut) ? json.leftOut.filter((r): r is string => typeof r === 'string') : [],
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
      phases: Object.fromEntries(
        PHASES.map((phase) => {
          const routes = readRoutes(join(this.dir, id, `${phase}.json`))
          return [phase, routes && Object.fromEntries(routes)]
        }),
      ) as PlanRoutes['phases'],
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

  /** A new plan folder named `name` (or the next free second), with `basedOn`'s files copied in: the dogs' phases with
   * only the robots added in Setup, the others as they are */
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
    const leftOut = new Set<string>()
    if (basedOn) {
      const added = this.lobby().robots
      for (const file of PLAN_FILES) {
        const from = join(this.dir, basedOn, file)
        if (!existsSync(from)) continue
        const phase = DOG_PHASES.find((p) => file === `${p}.json`)
        const routes = phase ? readRoutes(from) : null
        const kept = routes?.filter(([robot]) => added.includes(robot))
        if (!routes || !kept || kept.length === routes.length) {
          cpSync(from, join(folder, file))
          continue
        }
        for (const [robot] of routes) if (!added.includes(robot)) leftOut.add(robot)
        writeFileSync(join(folder, file), phaseJson(kept))
      }
    }
    this.writeSession(id, { basedOn, startedAt: Date.now(), finishedAt: null, recorded: [], leftOut: [...leftOut] })
    this.invalidate()
    return id
  }

  noteRecorded(id: string, recording: PlanRecording): void {
    const session = this.session(id) ?? { basedOn: null, startedAt: Date.now(), finishedAt: null, recorded: [], leftOut: [] }
    session.recorded.push(recording)
    this.writeSession(id, session)
    this.invalidate()
  }

  /** Ends a session: its plan stays, unless nothing was recorded into it and no robot left out. Returns whether it stays. */
  finish(id: string): boolean {
    const session = this.session(id)
    if (!session?.recorded.length && !session?.leftOut.length) {
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
