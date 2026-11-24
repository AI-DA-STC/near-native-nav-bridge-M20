import { mkdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import type { RawData, WebSocket } from 'ws'
import type {
  AlohaFacts,
  CommandResult,
  MissionCommand,
  MapReadFacts,
  MissionSnapshot,
  Notice,
  PhaseFacts,
  PlanFacts,
  Pt,
  RobotFacts,
  RouteFacts,
  SiteMap,
} from '../src/shared/api/mission-stream.ts'
import type { FlowFacts, PlanRoutes, PoseFact, Presence, RelayState, RobotKind } from '../src/shared/api/setup-protocol.ts'
import { FLEET, rolesOf, type RobotKey } from '../src/shared/config/fleet.ts'
import { EXIT_MARK, MissionRun, type EStopTarget } from './mission-run.ts'
import { readMission, type MissionRead } from './mission-output.ts'
import { CameraFeeds, type CameraRoles } from './camera-feeds.ts'
import { alohaSiteOf, readBox, siteMapOf, type GridImage } from './mission-site.ts'
import { readGrid, watchAmclPose, watchOdom } from './ros-checks.ts'
import type { Shell } from './shell-transcript.ts'

/* The Command center's live facts: the robots added in Setup in their mission roles (R1 741, R2 665, R3 738, a dog with
 * another ID in a free role), the plan in use, the robots' poses, the dogs' SLAM map, and the mission run_demo.sh is
 * running. Browsers get a MissionSnapshot on every change and at least once a second; their commands come back here. */

export interface MissionRobot {
  id: string
  kind: RobotKind
  ip: string
  presence: Presence
  setupDone: boolean
  /** An M20's relay, the ALOHA's bridge */
  relay: RelayState
  /** An M20's nav bridge */
  nav: RelayState
}

export interface MissionInputs {
  /** The robots added in Setup, in the lobby's order */
  robots: MissionRobot[]
  flow: FlowFacts
  /** Setup and Routes are confirmed (or MISSION_UNLOCKED): the Command center is open */
  open: boolean
}

export interface MissionHubDeps {
  packageRoot: string
  plansDir: string
  /** The plan demo/waypoints/current points at */
  currentPlan(): string | null
  planRoutes(id: string): PlanRoutes
  inputs(): MissionInputs
  /** The Mission terminal */
  terminal(): Shell & { readonly id: string; setActivity(activity: string): void; kill(): void }
  /** demo/run_demo.sh, or MISSION_SCRIPT */
  script: string
}

const LIMITS = { poseStaleMs: 3000, forceStopAfterMs: 8000 }
const MISSION_NAME = 'Coordinated search & discovery'
const DOGS = ['r1', 'r2', 'r3'] as const
const TRAIL_EVERY_MS = 1000
const TRAIL_POINTS = 120
const RUNNING: ReadonlySet<RelayState> = new Set(['running', 'kept'])

interface Tracked {
  pose: { x: number; y: number; yawDeg: number; at: number } | null
  speed: number | null
  trail: Pt[]
  lastTrailAt: number
  stop: () => void
}

export class MissionHub {
  private readonly deps: MissionHubDeps
  private readonly clients = new Set<WebSocket>()
  private readonly run: MissionRun
  private readonly tracked = new Map<string, Tracked>()
  private readonly cameras: CameraFeeds
  private seq = 0
  private grid: (GridImage & { robot: string }) | null = null
  private gridTried = 0
  private gridBusy = false
  /** The ALOHA's own map: /map on its bridge's ROS_DOMAIN_ID, and why there is none yet */
  private alohaGrid: GridImage | null = null
  private alohaGridTried = 0
  private alohaGridBusy = false
  private alohaGridFailure: { reason: string; at: number } | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private pushTimer: ReturnType<typeof setTimeout> | null = null
  private readonly defaultInstruction: string
  private routesCache: { key: string; routes: PlanRoutes | null } = { key: '', routes: null }

  constructor(deps: MissionHubDeps) {
    this.deps = deps
    this.run = new MissionRun({ terminal: deps.terminal, script: deps.script, packageRoot: deps.packageRoot, onChange: () => this.changed() })
    this.cameras = new CameraFeeds(deps.packageRoot, () => this.changed())
    let instruction = 'Execute a systematic sweep of Zone A to scan for unattended or anomalous items'
    try {
      instruction = /^INSTRUCTION="(.*)"$/m.exec(readFileSync(join(deps.packageRoot, 'demo', 'run_demo.sh'), 'utf8'))?.[1] ?? instruction
    } catch {
      // the default above is the script's own
    }
    this.defaultInstruction = instruction
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), 1000)
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    for (const t of this.tracked.values()) t.stop()
    this.tracked.clear()
    this.cameras.stop()
    await this.run.shutdown()
    for (const ws of this.clients) ws.close(1001, 'The setup server stopped')
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Browsers

  connect(ws: WebSocket): void {
    this.clients.add(ws)
    ws.send(JSON.stringify({ type: 'snapshot', snapshot: this.snapshot() }))
    ws.on('message', (raw: RawData) => void this.receive(ws, raw))
    ws.on('close', () => this.clients.delete(ws))
  }

  private async receive(ws: WebSocket, raw: RawData): Promise<void> {
    let message: (MissionCommand & { req: number }) | null = null
    try {
      message = JSON.parse(raw.toString()) as MissionCommand & { req: number }
    } catch {
      return
    }
    const result = await this.command(message).then(
      (): CommandResult => ({ ok: true, reason: null }),
      (error: unknown): CommandResult => ({ ok: false, reason: error instanceof Error ? error.message : String(error) }),
    )
    ws.send(JSON.stringify({ type: 'snapshot', snapshot: this.snapshot() }))
    ws.send(JSON.stringify({ type: 'result', req: message.req, ...result }))
  }

  /** A new snapshot for every browser, at most every 100 ms */
  changed(): void {
    if (this.pushTimer || !this.clients.size) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      const message = JSON.stringify({ type: 'snapshot', snapshot: this.snapshot() })
      for (const ws of this.clients) ws.send(message)
    }, 100)
  }

  // -------------------------------------------------------------------------------------------------------------------
  // What the page asks

  async command(command: MissionCommand): Promise<void> {
    const snap = this.snapshot()
    switch (command.type) {
      case 'start': {
        if (this.run.live) throw new Error('The mission is running')
        if (snap.run.blockers.length) throw new Error(`${snap.run.blockers[0].text}: ${snap.run.blockers[0].fix ?? ''}`.replace(/: $/, ''))
        const plan = this.plan()
        if (!plan) throw new Error('No plan in use: pick one on Routes')
        const r3 = [...this.roles()].find(([, key]) => key === 'r3')?.[0] ?? null
        this.run.reset()
        await this.run.start(this.folderForShell(plan), r3)
        return
      }
      case 'instruction':
        if (snap.run.awaiting !== 'instruction') throw new Error('The mission does not wait for an instruction now')
        return this.run.answer(String(command.text ?? '').trim())
      case 'decide-plan':
        if (snap.run.awaiting !== 'approval') throw new Error('No plan waits for approval')
        return this.run.answer(command.decision === 'approve' ? 'approve' : 'deny')
      case 'verdict':
        if (snap.run.awaiting !== 'verdict') throw new Error('The mission does not wait for the verdict')
        return this.run.answer(command.value === 'anomaly' ? 'anomaly' : 'clear')
      case 'stop':
        return this.run.stop()
      case 'force-stop':
        return this.run.forceStop()
      case 'estop':
        return this.run.emergencyStop(this.estopTargets())
      default:
        throw new Error('Unknown command')
    }
  }

  private estopTargets(): EStopTarget[] {
    const { robots } = this.deps.inputs()
    const roles = this.roles()
    const inMission = this.inMission()
    return robots.flatMap((r) => {
      const key = roles.get(r.id)
      if (!key || !inMission.has(r.id)) return []
      return [{ robot: key, ip: r.kind === 'm20' ? r.ip : null }]
    })
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The site

  /** GET /api/mission/site */
  site(): SiteMap {
    const plan = this.plan()
    return siteMapOf(plan ? this.routesOf(plan) : null, (id) => this.roles().get(id) ?? null, this.grid, readBox(this.deps.packageRoot))
  }

  /** GET /api/mission/site?map=aloha: the ALOHA's own map, apart from the dogs' */
  alohaSite(): SiteMap {
    const plan = this.plan()
    return alohaSiteOf(plan ? this.routesOf(plan) : null, this.alohaGrid)
  }

  /** The ALOHA's grid image, for GET /api/mission/aloha-map.png */
  alohaGridFile(): string {
    return join(this.deps.packageRoot, 'frontend', 'server', 'maps', 'aloha_grid.png')
  }

  /** The grid image's file, for GET /api/mission/map.png */
  gridFile(): string {
    return join(this.deps.packageRoot, 'frontend', 'server', 'maps', 'grid.png')
  }

  /** A file the scripts wrote that the page may show: demo/detections only */
  imageFile(path: string): string | null {
    const root = join(this.deps.packageRoot, 'demo', 'detections')
    const file = isAbsolute(path) ? path : join(this.deps.packageRoot, path)
    const rel = relative(root, file)
    return rel && !rel.startsWith('..') && !isAbsolute(rel) && /\.(jpe?g|png)$/i.test(file) ? file : null
  }

  private async ensureGrid(): Promise<void> {
    const { robots } = this.deps.inputs()
    const source = robots.find((r) => r.kind === 'm20' && RUNNING.has(r.relay) && r.presence === 'online')
    if (!source || this.gridBusy) return
    if (this.grid && robots.some((r) => r.id === this.grid!.robot)) return
    if (Date.now() - this.gridTried < 30_000) return
    this.gridBusy = true
    this.gridTried = Date.now()
    try {
      mkdirSync(join(this.deps.packageRoot, 'frontend', 'server', 'maps'), { recursive: true })
      const read = await readGrid(`/GRID_MAP_relayed_${source.id}`, 'frontend/server/maps/grid.png', this.deps.packageRoot)
      if (!read.ok) console.warn(`[mission] No map from ${source.id} yet: ${read.reason}`)
      else {
        this.grid = { robot: source.id, url: `/api/mission/map.png?v=${Date.now()}`, x: read.x, y: read.y, w: read.w, h: read.h }
        if (Math.abs(read.yaw) > 0.5) console.warn(`[mission] ${source.id}'s map origin is rotated ${read.yaw.toFixed(1)}°: the image is drawn unrotated`)
        this.changed()
      }
    } finally {
      this.gridBusy = false
    }
  }

  /** The ALOHA's map, read once from /map through its bridge (ROS_DOMAIN_ID=1) while its bridge runs. Its map server's
   * grid can be large (4000 x 4000 cells): map_grid.py keeps its known part, and is given 40 s for it to come through */
  private async ensureAlohaGrid(): Promise<void> {
    const { robots } = this.deps.inputs()
    const aloha = robots.find((r) => r.kind === 'aloha' && RUNNING.has(r.relay) && r.presence === 'online')
    if (!aloha || this.alohaGrid || this.alohaGridBusy || Date.now() - this.alohaGridTried < 30_000) return
    this.alohaGridBusy = true
    this.alohaGridTried = Date.now()
    this.changed()
    try {
      mkdirSync(join(this.deps.packageRoot, 'frontend', 'server', 'maps'), { recursive: true })
      const read = await readGrid('/map', 'frontend/server/maps/aloha_grid.png', this.deps.packageRoot, 1, 40)
      if (read.ok) {
        this.alohaGrid = { url: `/api/mission/aloha-map.png?v=${Date.now()}`, x: read.x, y: read.y, w: read.w, h: read.h }
        this.alohaGridFailure = null
        if (Math.abs(read.yaw) > 0.5) console.warn(`[mission] the ALOHA's map origin is rotated ${read.yaw.toFixed(1)}°: the image is drawn unrotated`)
      } else {
        if (read.reason !== this.alohaGridFailure?.reason) console.warn(`[mission] No map from the ALOHA yet: ${read.reason}`)
        this.alohaGridFailure = { reason: read.reason, at: Date.now() }
      }
    } finally {
      this.alohaGridBusy = false
      this.changed()
    }
  }

  /** The ALOHA's map for its tab: there, being read, or why not */
  private alohaMapFacts(): MapReadFacts {
    if (this.alohaGrid) return { state: 'ready', reason: null, at: this.alohaGridTried }
    if (this.alohaGridBusy) return { state: 'reading', reason: null, at: this.alohaGridTried }
    if (this.alohaGridFailure) return { state: 'failed', reason: this.alohaGridFailure.reason, at: this.alohaGridFailure.at }
    const aloha = this.deps.inputs().robots.find((r) => r.kind === 'aloha')
    const reason = !aloha
      ? 'The ALOHA is not added in Setup'
      : aloha.presence !== 'online'
        ? 'The ALOHA is offline'
        : !RUNNING.has(aloha.relay)
          ? 'Its bridge (aloha/bridge.sh) is not running: run the ALOHA’s setup'
          : null
    return { state: 'waiting', reason, at: null }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The robots

  private roles(): Map<string, RobotKey> {
    return rolesOf(this.deps.inputs().robots)
  }

  /** The plan in use: the one confirmed on Routes, else demo/waypoints/current */
  private plan(): string | null {
    return this.deps.inputs().flow.plan?.id ?? this.deps.currentPlan()
  }

  private routesOf(plan: string): PlanRoutes | null {
    const key = `${plan}:${Math.floor(Date.now() / 5000)}`
    if (this.routesCache.key !== key) {
      let routes: PlanRoutes | null = null
      try {
        routes = this.deps.planRoutes(plan)
      } catch {
        routes = null
      }
      this.routesCache = { key, routes }
    }
    return this.routesCache.routes
  }

  /** Robots added in Setup and named in the plan in use */
  private inMission(): Set<string> {
    const plan = this.plan()
    const routes = plan ? this.routesOf(plan) : null
    const named = new Set(Object.values(routes?.phases ?? {}).flatMap((phase) => Object.keys(phase ?? {})))
    return new Set(this.deps.inputs().robots.filter((r) => named.has(r.id)).map((r) => r.id))
  }

  private folderForShell(plan: string): string {
    const folder = join(this.deps.plansDir, plan)
    const rel = relative(this.deps.packageRoot, folder)
    return rel.startsWith('..') || isAbsolute(rel) ? folder : rel
  }

  /** Follows the poses of the robots in the mission while the Command center is open */
  private tick(): void {
    const { robots, open } = this.deps.inputs()
    const inMission = this.inMission()
    const wanted = new Set(open ? robots.filter((r) => inMission.has(r.id) && RUNNING.has(r.relay)).map((r) => r.id) : [])
    for (const [id, t] of this.tracked) {
      if (wanted.has(id)) continue
      t.stop()
      this.tracked.delete(id)
    }
    for (const id of wanted) {
      if (this.tracked.has(id)) continue
      const robot = robots.find((r) => r.id === id)!
      const t: Tracked = { pose: null, speed: null, trail: [], lastTrailAt: 0, stop: () => undefined }
      const onPose = (pose: PoseFact) => this.posed(t, pose)
      t.stop = robot.kind === 'aloha' ? watchAmclPose(this.deps.packageRoot, onPose) : watchOdom(id, this.deps.packageRoot, onPose)
      this.tracked.set(id, t)
    }
    // The cameras of the same robots that have one reaching the laptop: the ALOHA's wrist cameras, over its bridge
    this.cameras.follow(this.cameraRoles(wanted))
    if (open) {
      void this.ensureGrid()
      void this.ensureAlohaGrid()
    }
    if (this.clients.size) {
      const message = JSON.stringify({ type: 'snapshot', snapshot: this.snapshot() })
      for (const ws of this.clients) ws.send(message)
    }
  }

  /** Each role whose robot is among `ids`, with that robot's ID */
  private cameraRoles(ids: ReadonlySet<string>): CameraRoles {
    return Object.fromEntries([...this.roles()].filter(([id]) => ids.has(id)).map(([id, key]) => [key, id]))
  }

  /** The latest frame of a robot's camera, for GET /api/mission/camera/<key>.jpg */
  cameraFile(key: string): string | null {
    return this.cameras.file(key)
  }

  private posed(t: Tracked, pose: PoseFact): void {
    const previous = t.pose
    t.pose = { x: pose.x, y: pose.y, yawDeg: pose.yaw, at: pose.at }
    if (previous && pose.at > previous.at) t.speed = Math.hypot(pose.x - previous.x, pose.y - previous.y) / ((pose.at - previous.at) / 1000)
    if (pose.at - t.lastTrailAt >= TRAIL_EVERY_MS) {
      t.trail = [...t.trail, [pose.x, pose.y] as Pt].slice(-TRAIL_POINTS)
      t.lastTrailAt = pose.at
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The snapshot

  snapshot(): MissionSnapshot {
    const now = Date.now()
    const { robots: added } = this.deps.inputs()
    const roles = this.roles()
    const inMission = this.inMission()
    const idOf = (key: RobotKey) => [...roles].find(([, k]) => k === key)?.[0] ?? null
    const plan = this.plan()
    const routes = plan ? this.routesOf(plan) : null
    const waypointsOf = (kind: RouteFacts['kind'], id: string): { x: number; y: number }[] => {
      const file = kind === 'return' ? 'formation' : kind
      return routes?.phases[file as keyof PlanRoutes['phases']]?.[id] ?? []
    }
    const run = this.run
    const read: MissionRead | null = run.startedAt
      ? readMission(run.lines, run.pending, {
          roleOf: (id) => roles.get(id) ?? null,
          defaultInstruction: this.defaultInstruction,
          imageUrl: (path) => `/api/mission/image?path=${encodeURIComponent(path)}`,
          waypoints: (kind, id) => waypointsOf(kind, id).length,
        }, run.startedAt)
      : null

    const robotFacts = (key: RobotKey): RobotFacts => {
      const id = idOf(key)
      const robot = id ? added.find((r) => r.id === id) : undefined
      const t = id ? this.tracked.get(id) : undefined
      const connected = robot
        ? robot.kind === 'aloha'
          ? RUNNING.has(robot.relay)
          : RUNNING.has(robot.nav) && robot.presence === 'online'
        : false
      let route = id && read ? (read.routes[key === 'aloha' ? 'aloha' : id] ?? null) : null
      if (route && id) {
        const wps = waypointsOf(route.kind, key === 'aloha' ? 'aloha' : id)
        const goal = route.target !== null ? (wps[route.target - 1] ?? null) : null
        const pose = t?.pose
        route = {
          ...route,
          goal: goal ? { x: goal.x, y: goal.y } : null,
          // The ALOHA's route and pose are both on its own map: the distance holds for it too
          distanceRemaining: goal && pose ? Math.hypot(goal.x - pose.x, goal.y - pose.y) : null,
        }
      }
      return {
        id: id ?? (key === 'aloha' ? '' : FLEET[key].id),
        inMission: id !== null && inMission.has(id),
        domain: key === 'aloha' ? 1 : 0,
        bridge: connected ? 'connected' : 'disconnected',
        pose: t?.pose ?? null,
        speed: t?.speed ?? null,
        trail: t?.trail ?? [],
        route,
      }
    }
    const alohaBase = robotFacts('aloha')
    const aloha: AlohaFacts = {
      ...alohaBase,
      sameMap: false,
      nav: alohaBase.bridge === 'connected' && !read?.navWaiting ? 'ready' : 'waiting',
      docking: read?.docking ?? { attempt: 0, of: 1, state: 'idle', reason: null },
      arms: read?.arms ?? { pose: 0, of: 5, state: 'idle', holdEndsAt: null },
    }
    const robots = { r1: robotFacts('r1'), r2: robotFacts('r2'), r3: robotFacts('r3'), aloha }

    // What keeps Start off: the same facts the page shows
    const blockers: Notice[] = []
    const block = (id: string, robot: RobotKey | null, text: string, fix: string | null) => blockers.push({ id, tone: 'fault', robot, text, fix, since: now })
    if (!plan) block('plan', null, 'No plan in use', 'pick one on Routes')
    else if (!routes) block('plan', null, `The plan ${plan} cannot be read`, 'pick another on Routes')
    const missionDogs = DOGS.filter((k) => robots[k].inMission)
    if (plan && !missionDogs.length) block('dogs', null, 'No robot dog in this mission', 'add them on Setup, and record their routes on Routes')
    for (const key of missionDogs) {
      const facts = robots[key]
      if (facts.bridge !== 'connected') block(`bridge-${key}`, key, `Robot ${facts.id} not connected`, 'is its nav bridge running? Run its setup again on Setup')
      else if (!facts.pose || now - facts.pose.at > LIMITS.poseStaleMs) block(`pose-${key}`, key, `No position from robot ${facts.id}`, 'is its relay running?')
    }
    if (aloha.inMission && aloha.bridge !== 'connected') block('aloha', 'aloha', 'ALOHA not connected', 'is its bridge running? Run its setup again on Setup')

    const status = run.status
    const ended = status === 'ended'
    const exit = read?.exit ?? null
    const outcome: MissionSnapshot['run']['outcome'] = !ended
      ? null
      : run.estopped
        ? 'estopped'
        : exit === 0
          ? read?.verdict?.value === 'anomaly'
            ? 'anomaly'
            : 'complete'
          : exit === 130 || run.stopRequestedAt
            ? 'stopped'
            : 'failed'
    const phases: PhaseFacts[] = (read?.phases ?? []).map((p) => ({ ...p }))
    if (!read) {
      for (const id of ['ready', 'patrol', 'formation', 'approval', 'sweep', 'cordon', 'inspect', 'verdict', 'return'] as const)
        phases.push({ id, status: id === 'ready' ? 'active' : 'pending', startedAt: null, endedAt: null, detail: id === 'ready' ? 'Bring-up: nav bridges, positions, the ALOHA' : '' })
    }
    if (ended) {
      for (const p of phases) {
        if (p.status === 'active') Object.assign(p, { status: outcome === 'complete' || outcome === 'anomaly' ? 'done' : outcome === 'failed' ? 'failed' : 'stopped', endedAt: run.endedAt })
        else if (p.status === 'pending' && (outcome === 'complete' || outcome === 'anomaly')) p.status = 'skipped'
      }
    }
    const plans: PlanFacts[] = (read?.plans ?? []).map((p) => {
      if (!ended) return p
      if (p.status === 'generating' || p.status === 'awaiting') return { ...p, status: 'undecided' }
      if (p.status === 'approved' || p.status === 'executing') return { ...p, status: outcome === 'complete' || outcome === 'anomaly' ? 'completed' : outcome === 'failed' ? 'failed' : 'stopped' }
      return p
    })
    return {
      seq: ++this.seq,
      serverTime: now,
      limits: LIMITS,
      mission: { name: MISSION_NAME, defaultInstruction: this.defaultInstruction },
      run: {
        status,
        outcome,
        reason: ended ? (run.error ?? read?.failure ?? (outcome === 'failed' ? (run.lines.filter((l) => !l.text.startsWith(EXIT_MARK)).at(-1)?.text ?? null) : null)) : null,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        stopRequestedAt: run.stopRequestedAt,
        awaiting: status === 'running' ? (read?.awaiting ?? null) : null,
        blockers: run.live ? [] : blockers,
      },
      phases,
      instruction: read?.instruction ?? null,
      plans,
      robots,
      detection: read?.detection ?? null,
      contents: read?.contents ?? { state: 'waiting', photo: null, objects: [] },
      verdict: read?.verdict ?? null,
      warnings: read?.warnings ?? [],
      estop: run.estop,
      timeline: read?.timeline ?? [],
      output: run.lines.slice(-400).map((l) => l.text),
      cameras: this.cameras.facts(this.cameraRoles(inMission)),
      alohaMap: this.alohaMapFacts(),
      siteVersion: `${plan ?? ''}|${this.grid?.url ?? ''}|${[...roles].map(([id, k]) => `${id}=${k}`).join(',')}|${JSON.stringify(readBox(this.deps.packageRoot))}|${this.alohaGrid?.url ?? ''}`,
    }
  }
}
