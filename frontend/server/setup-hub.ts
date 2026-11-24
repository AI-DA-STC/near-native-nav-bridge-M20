import { hostname } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import type { RawData, WebSocket } from 'ws'
import type {
  ClientMessage,
  FlowFacts,
  PlanRoutes,
  PromptChoice,
  RecorderKey,
  RelayState,
  RobotKind,
  RobotSetupFacts,
  RobotSuggestion,
  RoutePhase,
  RvizWhich,
  ServerMessage,
  SetupCommand,
  SetupRunState,
  SetupSnapshot,
  SetupStepFacts,
  SetupStepKey,
} from '../src/shared/api/setup-protocol.ts'
import { FLEET, ROBOT_KEYS } from '../src/shared/config/fleet.ts'
import { ALOHA_STEPS, detachTmux, leaveAloha, pendingAlohaStep, runAlohaSetup, type AlohaSetupContext } from './aloha-setup.ts'
import { afterEcho } from './command-output.ts'
import { M20_STEPS, pendingStep, runM20Setup, type M20SetupContext } from './m20-setup.ts'
import { pingCommand, pingTargets, readDefaultGateway } from './ping-terminals.ts'
import { PresenceMonitor, answers, type PresenceTarget } from './presence.ts'
import { ALOHA, DEFAULT_LOGIN, README, ROBOT_ID_PATTERN, USER_PATTERN } from './readme-commands.ts'
import { RobotStore, type StoredRobot } from './robot-store.ts'
import { masterSystemState } from './ros1-master.ts'
import { domainTopics, goalListeners, odomPublishers, topicRate, watchAlohaInitialPose, watchAmclPose, watchInitialPose, watchOdom } from './ros-checks.ts'
import { PHASES, PHASE_RULES, PHASE_TITLE, RoutePlans, participantsOf, planName, type Lobby } from './route-plans.ts'
import { MissionHub } from './mission-hub.ts'
import { RouteRecorder } from './route-recorder.ts'
import { RvizWindow, writeRoutesRviz } from './routes-rviz.ts'
import { writeAlohaRviz, writeRobotRviz } from './rviz-config.ts'
import { placeOf, promptAtEnd } from './shell-prompt.ts'
import { Aborted, ShellExited, type Shell } from './shell-transcript.ts'
import { leaveRobot, logIn, type LoginContext } from './ssh-login.ts'
import { command, settle } from './step-shell.ts'
import { TerminalSession } from './terminal-session.ts'

/* The setup server's state: the robots added in the lobby, whether they answer, their setup runs and terminals, the
 * mission plans and their recording, the operator's way through Setup and Routes, and the browsers watching. A browser
 * gets a snapshot on every change and the output of the terminals it opens. */

interface PendingAnswer {
  key: SetupStepKey
  resolve: (choice: PromptChoice) => void
}

interface Robot {
  stored: StoredRobot
  steps: SetupStepFacts[]
  run: { state: SetupRunState; startedAt: number | null; endedAt: number | null }
  /** The run going on, if any */
  active: { abort: AbortController; done: Promise<void> } | null
  answer: PendingAnswer | null
  /** An M20's relay (robot terminal), the ALOHA's bridge (laptop terminal) */
  relay: { state: RelayState; since: number | null; rateHz: number | null }
  relayWatch: AbortController | null
  /** An M20's nav bridge (nav terminal) */
  nav: { state: RelayState; since: number | null }
  navWatch: AbortController | null
  sessions: { robot: TerminalSession | null; laptop: TerminalSession | null; nav: TerminalSession | null }
}

interface Client {
  ws: WebSocket
  /** Session id → stop streaming it */
  watching: Map<string, () => void>
}

export interface SetupHubOptions {
  /** The package root, where the laptop's README commands run (fastdds_profile.xml, install/, demo/) */
  packageRoot: string
  storeFile: string
  /** The plans: demo/waypoints by default */
  plansDir?: string
  /** The Command center opens without Setup and Routes confirmed (MISSION_UNLOCKED=1) */
  unlocked?: boolean
  /** The mission script, relative to the package root: demo/run_demo.sh unless MISSION_SCRIPT says otherwise */
  missionScript?: string
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/** The README's robots, in the lobby's order: the three dogs, then the ALOHA */
const README_ROBOTS: Array<{ kind: RobotKind; id: string; ip: string; user: string }> = ROBOT_KEYS.map((key) => {
  const r = FLEET[key]
  const kind: RobotKind = r.kind === 'aloha' ? 'aloha' : 'm20'
  return { kind, id: r.kind === 'aloha' ? 'aloha' : r.id, ip: r.ip, user: DEFAULT_LOGIN[kind].user }
})

/** record_waypoints.sh records the ALOHA under this ID, the key aloha.json keeps its route under */
const ALOHA_ROUTE_ID = 'aloha'

/** Where each kind's long-running program is: an M20's relay in the robot terminal, the ALOHA's bridge in the laptop's */
const RELAY_ROLE: Record<RobotKind, 'robot' | 'laptop'> = { m20: 'robot', aloha: 'laptop' }

export class SetupHub {
  private readonly robots = new Map<string, Robot>()
  private readonly sessions = new Map<string, TerminalSession>()
  private readonly clients = new Set<Client>()
  private readonly presence: PresenceMonitor
  private readonly store: RobotStore
  private readonly packageRoot: string
  private readonly plans: RoutePlans
  private readonly recorder: RouteRecorder
  private readonly laptopHost = hostname()
  private flow: FlowFacts
  private routeSession: { plan: string; basedOn: string | null; startedAt: number } | null = null
  private routesTerminal: TerminalSession | null = null
  private readonly rvizTerminals: Record<RvizWhich, TerminalSession | null> = { dogs: null, aloha: null }
  private readonly rviz: Record<RvizWhich, RvizWindow>
  /** The Command center: the robots in their mission roles, their poses, the mission run */
  readonly mission: MissionHub
  private missionTerminal: TerminalSession | null = null
  /** Fleet health's ping dashboards, by robot ID (or the router's) */
  private readonly pingTerminals = new Map<string, { name: string; ip: string; session: TerminalSession }>()
  private router: string | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private sessionCount = 0
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null
  private closing = false

  constructor(options: SetupHubOptions) {
    this.packageRoot = options.packageRoot
    this.store = new RobotStore(options.storeFile)
    this.flow = { setupConfirmedAt: null, plan: null, unlocked: options.unlocked ?? false }
    this.presence = new PresenceMonitor(() => this.changed())
    this.plans = new RoutePlans(options.plansDir ?? join(options.packageRoot, 'demo', 'waypoints'), () => this.lobby(), () => this.changed())
    this.recorder = new RouteRecorder({
      terminal: () => this.routesShell(),
      folderForShell: (plan) => {
        const folder = join(this.plans.dir, plan)
        const rel = relative(this.packageRoot, folder)
        return rel.startsWith('..') || isAbsolute(rel) ? folder : rel
      },
      watchPose: (robot, phase, onPose) => (phase === 'aloha' ? watchAmclPose(this.packageRoot, onPose) : watchOdom(robot, this.packageRoot, onPose)),
      onChange: () => this.changed(),
      onSaved: (plan, recording) => this.plans.noteRecorded(plan, recording),
    })
    const rvizFor = (which: RvizWhich) =>
      new RvizWindow({
        which,
        terminal: () => this.rvizShell(which),
        existing: () => this.rvizTerminals[which],
        writeConfig: () => writeRoutesRviz(which, this.lobby().participants.patrol),
        onChange: () => this.changed(),
      })
    this.rviz = { dogs: rvizFor('dogs'), aloha: rvizFor('aloha') }
    this.mission = new MissionHub({
      packageRoot: this.packageRoot,
      plansDir: this.plans.dir,
      currentPlan: () => this.plans.current(),
      planRoutes: (id) => this.plans.routes(id),
      inputs: () => ({
        robots: this.lobbyRobots().map((r) => ({
          id: r.stored.id,
          kind: r.stored.kind,
          ip: r.stored.ip,
          presence: this.presence.get(r.stored.id).presence,
          setupDone: r.run.state === 'done',
          relay: r.relay.state,
          nav: r.nav.state,
        })),
        flow: this.flow,
        open: this.flow.unlocked || (this.flow.setupConfirmedAt !== null && this.flow.plan !== null),
      }),
      terminal: () => this.missionShell(),
      script: options.missionScript ?? 'demo/run_demo.sh',
    })
    for (const stored of this.store.load()) this.robots.set(stored.id, this.newRobot(stored))
    this.updatePresenceTargets()
  }

  start(): void {
    this.presence.start()
    this.plans.start()
    this.mission.start()
    this.followPing()
    this.pingTimer = setInterval(() => this.followPing(), 30_000)
    this.pingTimer.unref()
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Browsers

  connect(ws: WebSocket): void {
    const client: Client = { ws, watching: new Map() }
    this.clients.add(client)
    this.send(client, { type: 'snapshot', snapshot: this.snapshot() })
    ws.on('message', (raw) => this.receive(client, raw))
    ws.on('close', () => {
      for (const stop of client.watching.values()) stop()
      this.clients.delete(client)
    })
  }

  private send(client: Client, message: ServerMessage): void {
    if (client.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(message))
  }

  private receive(client: Client, raw: RawData): void {
    let message: ClientMessage
    try {
      message = JSON.parse(String(raw)) as ClientMessage
    } catch {
      return
    }
    switch (message.type) {
      case 'term-subscribe':
        return this.watchSession(client, message.session)
      case 'term-unsubscribe':
        client.watching.get(message.session)?.()
        client.watching.delete(message.session)
        return
      case 'term-input':
        if (typeof message.data === 'string') this.sessions.get(message.session)?.write(message.data)
        return
      case 'term-resize':
        if (Number.isFinite(message.cols) && Number.isFinite(message.rows)) this.sessions.get(message.session)?.resize(message.cols, message.rows)
        return
      default: {
        const req = message.req
        this.command(message).then(
          () => {
            // What the command changed reaches this page before its answer: a page that moves on (Use this plan, to the
            // Command center) already sees it confirmed
            this.send(client, { type: 'snapshot', snapshot: this.snapshot() })
            this.send(client, { type: 'result', req, ok: true, error: null })
          },
          (error: unknown) => this.send(client, { type: 'result', req, ok: false, error: error instanceof Error ? error.message : String(error) }),
        )
      }
    }
  }

  /** Streams a terminal to one browser: its scrollback first, then what it prints, a frame's worth at a time */
  private watchSession(client: Client, id: string): void {
    const session = this.sessions.get(id)
    if (!session || client.watching.has(id)) return
    let pending = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    const flush = () => {
      timer = null
      if (pending) this.send(client, { type: 'term-output', session: id, data: pending, replay: false })
      pending = ''
    }
    const stop = session.watch(
      (scrollback) => this.send(client, { type: 'term-output', session: id, data: scrollback, replay: true }),
      (data) => {
        pending += data
        timer ??= setTimeout(flush, 16)
      },
    )
    client.watching.set(id, () => {
      stop()
      if (timer) clearTimeout(timer)
    })
  }

  /** A new snapshot for every browser, at most every 50 ms */
  private changed(): void {
    if (this.broadcastTimer || this.closing) return
    this.mission?.changed()
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null
      const message: ServerMessage = { type: 'snapshot', snapshot: this.snapshot() }
      for (const client of this.clients) this.send(client, message)
    }, 50)
  }

  /** The robots added, in the lobby's order */
  private lobbyRobots(): Robot[] {
    return [...this.robots.values()].sort((a, b) => a.stored.addedAt - b.stored.addedAt)
  }

  /** What the plans are checked against: the robots added in Setup, and who of them takes part in each phase */
  private lobby(): Lobby {
    const robots = this.lobbyRobots().map((r) => r.stored)
    return { robots: robots.map((r) => r.id), participants: participantsOf(robots) }
  }

  snapshot(): SetupSnapshot {
    const robots = this.lobbyRobots()
    return {
      serverTime: Date.now(),
      robots: robots.map((r) => this.factsOf(r)),
      suggestions: this.suggestions(),
      sessions: [...this.sessions.values()].map((s) => s.facts()),
      flow: this.flow,
      plans: this.plans.list(),
      session: this.routeSession
        ? {
            ...this.routeSession,
            recording: this.recorder.facts,
            terminal: this.routesTerminal?.id ?? null,
            rviz: { dogs: this.rviz.dogs.state, aloha: this.rviz.aloha.state },
          }
        : null,
      participants: this.lobby().participants,
    }
  }

  /** A plan's waypoints, for its preview (GET /api/plans/<id>) */
  planRoutes(id: string): PlanRoutes {
    return this.plans.routes(id)
  }

  private factsOf(robot: Robot): RobotSetupFacts {
    const { kind, id, ip, user, addedAt, lastReadyAt } = robot.stored
    const presence = this.presence.get(id)
    return {
      kind,
      id,
      ip,
      user,
      addedAt,
      presence: presence.presence,
      presenceSince: presence.since,
      lastSeen: presence.lastSeen,
      setup: { ...robot.run, steps: robot.steps },
      relay: robot.relay,
      lastReadyAt,
      nav: robot.nav,
      sessions: { robot: robot.sessions.robot?.id ?? null, laptop: robot.sessions.laptop?.id ?? null, nav: robot.sessions.nav?.id ?? null },
    }
  }

  /** The README's robots not added yet, by ID or by IP */
  private suggestions(): RobotSuggestion[] {
    const added = [...this.robots.values()].map((r) => r.stored)
    return README_ROBOTS.filter((s) => !added.some((r) => r.id === s.id || r.ip === s.ip)).map((s) => ({
      ...s,
      presence: this.presence.get(`suggestion:${s.id}`).presence,
    }))
  }

  private updatePresenceTargets(): void {
    const ports = (kind: RobotKind) => (kind === 'aloha' ? [22, 11311] : [22])
    const targets: PresenceTarget[] = [...this.robots.values()].map(({ stored }) => ({ key: stored.id, ip: stored.ip, ports: ports(stored.kind) }))
    for (const s of this.suggestions()) targets.push({ key: `suggestion:${s.id}`, ip: s.ip, ports: ports(s.kind) })
    this.presence.setTargets(targets)
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Commands from the page

  async command(command: SetupCommand): Promise<void> {
    switch (command.type) {
      case 'add-robot':
        return this.addRobot(command.kind, String(command.id ?? '').trim(), String(command.ip ?? '').trim(), String(command.user ?? '').trim(), command.password)
      case 'remove-robot':
        return this.removeRobot(command.robot)
      case 'start-setup':
        return this.startSetup(command.robot, 'login')
      case 'retry-step': {
        const robot = this.robot(command.robot)
        const from = robot.steps.find((s) => s.status !== 'done' && s.status !== 'skipped')?.key ?? 'login'
        return this.startSetup(command.robot, from)
      }
      case 'stop-setup':
        return this.stopSetup(command.robot)
      case 'answer':
        return this.answer(command.robot, command.choice, command.password)
      case 'confirm-setup':
        return this.confirmSetup()
      case 'confirm-plan':
        return this.confirmPlan(String(command.plan))
      case 'new-session':
        return this.newSession(command.basedOn, Number(command.utcOffsetMinutes) || 0)
      case 'record-start':
        return this.recordStart(command.phase, String(command.robot), Boolean(command.append))
      case 'record-key':
        return this.recordKey(command.key)
      case 'open-rviz':
        return this.openRviz(command.which)
      case 'finish-session':
        return this.finishSession()
      case 'discard-session':
        return this.discardSession()
      default:
        throw new Error('Unknown command')
    }
  }

  private robot(id: string): Robot {
    const robot = this.robots.get(id)
    if (!robot) throw new Error(`No robot ${id}`)
    return robot
  }

  private stepsFor(stored: StoredRobot): SetupStepFacts[] {
    return stored.kind === 'aloha' ? ALOHA_STEPS.map((key) => pendingAlohaStep(key, stored)) : M20_STEPS.map((key) => pendingStep(key, stored))
  }

  private newRobot(stored: StoredRobot): Robot {
    return {
      stored,
      steps: this.stepsFor(stored),
      run: { state: 'idle', startedAt: null, endedAt: null },
      active: null,
      answer: null,
      relay: { state: 'none', since: null, rateHz: null },
      relayWatch: null,
      nav: { state: 'none', since: null },
      navWatch: null,
      sessions: { robot: null, laptop: null, nav: null },
    }
  }

  private async addRobot(kind: RobotKind, id: string, ip: string, user: string, password: string | null | undefined): Promise<void> {
    if (kind !== 'm20' && kind !== 'aloha') throw new Error('The kind is m20 or aloha')
    if (!ROBOT_ID_PATTERN.test(id) || id.length > 32) throw new Error('The robot ID takes letters, digits and _ only')
    if (!IPV4.test(ip)) throw new Error(`${ip || 'The IP'} is not an IPv4 address`)
    const login = user || DEFAULT_LOGIN[kind].user
    if (!USER_PATTERN.test(login)) throw new Error(`${login} is not a login name: lowercase letters, digits, _ and -`)
    if (password !== null && password !== undefined && (typeof password !== 'string' || password.length > 128)) throw new Error('The password is too long')
    if (this.robots.has(id)) throw new Error(`Robot ${id} is already added`)
    const sameIp = [...this.robots.values()].find((r) => r.stored.ip === ip)
    if (sameIp) throw new Error(`${ip} is robot ${sameIp.stored.id}'s IP`)
    const robot = this.newRobot({
      kind,
      id,
      ip,
      user: login,
      password: password || DEFAULT_LOGIN[kind].password,
      addedAt: Date.now(),
      lastReadyAt: null,
    })
    this.robots.set(id, robot)
    this.flow = { ...this.flow, setupConfirmedAt: null }
    this.save()
    this.updatePresenceTargets()
    this.followPing()
    this.plans.invalidate()
    // A robot that answers starts its setup at once; one that does not waits for the operator
    if (await answers(ip, 22)) await this.startSetup(id, 'login')
  }

  private async removeRobot(id: string): Promise<void> {
    const robot = this.robot(id)
    await this.stopRun(robot)
    if (robot.stored.kind === 'aloha') await this.stopAlohaStack(robot).catch((error: unknown) => console.warn(`[setup] ${id}: ${String(error)}`))
    await this.closeSessions(robot)
    this.robots.delete(id)
    this.flow = { ...this.flow, setupConfirmedAt: null }
    this.save()
    this.updatePresenceTargets()
    this.followPing()
    this.plans.invalidate()
  }

  private save(): void {
    this.store.save([...this.robots.values()].map((r) => r.stored))
  }

  private async startSetup(id: string, from: SetupStepKey): Promise<void> {
    const robot = this.robot(id)
    await this.stopRun(robot)
    if (!(await answers(robot.stored.ip, 22))) throw new Error(`${id} does not answer at ${robot.stored.ip}`)
    if (from === 'login') {
      // From the start: what the last run left running stops first, as you would stop it by hand
      robot.steps = this.stepsFor(robot.stored)
      robot.run = { state: 'running', startedAt: Date.now(), endedAt: null }
      this.flow = { ...this.flow, setupConfirmedAt: null }
      this.changed()
      await this.stopRelay(robot)
      await this.stopNav(robot)
      const laptop = robot.sessions.laptop
      if (laptop && !laptop.exited) await settle(laptop, undefined, 500).catch(() => laptop.kill())
    }
    const abort = new AbortController()
    robot.run = { state: 'running', startedAt: robot.run.startedAt && from !== 'login' ? robot.run.startedAt : Date.now(), endedAt: null }
    const run =
      robot.stored.kind === 'aloha' ? runAlohaSetup(this.alohaContextFor(robot, abort.signal), from) : runM20Setup(this.m20ContextFor(robot, abort.signal), from)
    const done = run.then(
      () => {
        robot.run = { ...robot.run, state: 'done', endedAt: Date.now() }
        robot.stored.lastReadyAt = Date.now()
        this.save()
      },
      (error: unknown) => {
        robot.run = { ...robot.run, state: error instanceof Aborted ? 'stopped' : 'failed', endedAt: Date.now() }
        if (!(error instanceof Aborted)) console.warn(`[setup] ${id}: ${error instanceof Error ? error.message : String(error)}`)
      },
    )
    robot.active = {
      abort,
      done: done.finally(() => {
        robot.active = null
        robot.answer = null
        this.changed()
      }),
    }
    this.changed()
  }

  private async stopSetup(id: string): Promise<void> {
    const robot = this.robot(id)
    if (!robot.active) throw new Error(`${id}'s setup is not running`)
    await this.stopRun(robot)
  }

  private async stopRun(robot: Robot): Promise<void> {
    if (!robot.active) return
    robot.active.abort.abort()
    await robot.active.done
  }

  private async answer(id: string, choice: PromptChoice, password: string | undefined): Promise<void> {
    const robot = this.robot(id)
    if (!robot.answer) throw new Error(`${id}'s setup is not waiting for an answer`)
    if (choice === 'retry-login') {
      if (typeof password !== 'string' || !password || password.length > 128) throw new Error('Type the password first')
      robot.stored.password = password
      this.save()
    }
    robot.answer.resolve(choice)
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Setup, then Routes, then the Command center

  /** Ready for the mission: set up, its relay or bridge (and an M20's nav bridge) running, still answering */
  private ready(robot: Robot): boolean {
    const navUp = robot.stored.kind === 'aloha' || (robot.nav.state !== 'exited' && robot.nav.state !== 'none')
    return this.presence.get(robot.stored.id).presence === 'online' && robot.run.state === 'done' && robot.relay.state !== 'exited' && navUp
  }

  private async confirmSetup(): Promise<void> {
    const robots = [...this.robots.values()]
    if (!robots.length) throw new Error('Add the robots first')
    const waiting = robots.filter((r) => !this.ready(r)).map((r) => (r.stored.kind === 'aloha' ? 'ALOHA' : r.stored.id))
    if (waiting.length) throw new Error(`Not ready yet: ${waiting.join(', ')}`)
    this.flow = { ...this.flow, setupConfirmedAt: Date.now() }
    this.changed()
  }

  private async confirmPlan(id: string): Promise<void> {
    if (this.routeSession) throw new Error('Finish or discard the recording session first')
    const plan = this.plans.list().find((p) => p.id === id)
    if (!plan) throw new Error(`No plan ${id}`)
    if (plan.problems.length) throw new Error(`${id} is not complete: ${plan.problems[0]}`)
    this.plans.use(id)
    this.flow = { ...this.flow, plan: { id, confirmedAt: Date.now() } }
    this.changed()
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Recording routes

  private async newSession(basedOn: string | null, utcOffsetMinutes: number): Promise<void> {
    if (this.routeSession) throw new Error(`A session is open: ${this.routeSession.plan}`)
    if (Math.abs(utcOffsetMinutes) > 14 * 60) throw new Error('That is not a timezone')
    const plan = this.plans.newSession(basedOn, planName(Date.now(), utcOffsetMinutes))
    this.routeSession = { plan, basedOn, startedAt: Date.now() }
    this.recorder.facts = null
    this.changed()
  }

  private async recordStart(phase: RoutePhase, robotId: string, append: boolean): Promise<void> {
    if (!this.routeSession) throw new Error('Start a recording session first')
    if (!PHASES.includes(phase)) throw new Error(`No phase ${String(phase)}`)
    const robot = this.robots.get(robotId)
    if (!robot) throw new Error(`${robotId} is not added in Setup`)
    if (!this.lobby().participants[phase].includes(robotId)) throw new Error(`${robotId} takes no part in ${PHASE_TITLE[phase]}`)
    if (phase === 'aloha' && robotId !== ALOHA_ROUTE_ID) throw new Error(`record_waypoints.sh records the ALOHA as ${ALOHA_ROUTE_ID}: add it with that ID`)
    if (append && PHASE_RULES[phase].max === 1) throw new Error(`The ${phase} takes one waypoint per robot: nothing to add to`)
    const what = robot.stored.kind === 'aloha' ? 'bridge' : 'relay'
    if (robot.relay.state !== 'running' && robot.relay.state !== 'kept') throw new Error(`${robotId}’s ${what} is not running: set it up first`)
    if (this.recorder.busy) throw new Error(`Recording ${this.recorder.facts!.robot}’s ${this.recorder.facts!.phase}: save or cancel it first`)
    // Its RViz first, to watch the waypoints on the map: a recording goes on without it, and Open RViz again retries
    await this.rviz[phase === 'aloha' ? 'aloha' : 'dogs'].open().catch((error: unknown) => console.warn(`[routes] ${String(error)}`))
    await this.recorder.start(this.routeSession.plan, phase, robotId, append)
  }

  private async openRviz(which: RvizWhich): Promise<void> {
    if (which !== 'dogs' && which !== 'aloha') throw new Error(`No RViz ${String(which)}`)
    if (!this.routeSession) throw new Error('Start a recording session first')
    if (which === 'dogs' && !this.lobby().participants.patrol.length) throw new Error('No dog is added: its RViz shows the dogs’ map')
    await this.rviz[which].open()
  }

  private async closeRviz(): Promise<void> {
    await Promise.all([this.rviz.dogs.close(), this.rviz.aloha.close()])
  }

  private async recordKey(key: RecorderKey): Promise<void> {
    if (!['record', 'undo', 'clear', 'save', 'cancel'].includes(key)) throw new Error(`No key ${String(key)}`)
    this.recorder.key(key)
  }

  private async finishSession(): Promise<void> {
    if (!this.routeSession) throw new Error('No recording session is open')
    if (this.recorder.busy) throw new Error('Save or cancel the recording first')
    this.plans.finish(this.routeSession.plan)
    this.routeSession = null
    this.recorder.facts = null
    this.changed()
    await this.closeRviz()
  }

  private async discardSession(): Promise<void> {
    if (!this.routeSession) throw new Error('No recording session is open')
    await this.recorder.cancel()
    this.plans.discard(this.routeSession.plan)
    this.routeSession = null
    this.recorder.facts = null
    this.changed()
    await this.closeRviz()
  }

  /** The Routes terminal: a laptop shell in the package root for demo/record_waypoints.sh */
  private routesShell(): TerminalSession {
    const current = this.routesTerminal
    if (current && !current.exited) return current
    if (current) this.sessions.delete(current.id)
    const session = new TerminalSession(
      { id: `routes-${++this.sessionCount}`, robot: 'routes', role: 'routes', cwd: this.packageRoot, cols: 160, rows: 40 },
      () => this.changed(),
    )
    this.routesTerminal = session
    this.sessions.set(session.id, session)
    this.changed()
    return session
  }

  /** The Mission terminal: a laptop shell in the package root for demo/run_demo.sh */
  private missionShell(): TerminalSession {
    const current = this.missionTerminal
    if (current && !current.exited) return current
    if (current) this.sessions.delete(current.id)
    const session = new TerminalSession({ id: `mission-${++this.sessionCount}`, robot: 'mission', role: 'mission', cwd: this.packageRoot, cols: 160, rows: 40 }, () =>
      this.changed(),
    )
    this.missionTerminal = session
    this.sessions.set(session.id, session)
    this.changed()
    return session
  }

  /** The terminal an RViz for recording runs in: a laptop shell in the package root */
  private rvizShell(which: RvizWhich): TerminalSession {
    const current = this.rvizTerminals[which]
    if (current && !current.exited) return current
    if (current) this.sessions.delete(current.id)
    const role = which === 'dogs' ? 'rviz-dogs' : 'rviz-aloha'
    const session = new TerminalSession({ id: `${role}-${++this.sessionCount}`, robot: 'routes', role, cwd: this.packageRoot, cols: 160, rows: 40 }, () =>
      this.changed(),
    )
    this.rvizTerminals[which] = session
    this.sessions.set(session.id, session)
    this.changed()
    return session
  }

  /** Fleet health: a ping dashboard (net_dash.py) for every robot added and the router, each in a laptop terminal of
   * its own, from the start. One that ended (exit typed in it) opens again within 30 s. While the Wi-Fi is down the
   * router stays the last gateway seen, whose terminal then shows the pings failing. */
  private followPing(): void {
    if (this.closing) return
    this.router = readDefaultGateway() ?? this.router
    const targets = pingTargets(
      this.lobbyRobots().map((r) => r.stored),
      this.router,
    )
    let changed = false
    for (const [key, held] of this.pingTerminals) {
      const target = targets.find((t) => t.key === key)
      if (target && target.ip === held.ip && target.name === held.name && !held.session.exited) continue
      held.session.kill()
      this.sessions.delete(held.session.id)
      this.pingTerminals.delete(key)
      changed = true
    }
    for (const target of targets) {
      if (this.pingTerminals.has(target.key)) continue
      const session = new TerminalSession(
        { id: `${target.key}-ping-${++this.sessionCount}`, robot: target.key, role: 'ping', cwd: this.packageRoot, cols: 100, rows: 30 },
        () => this.changed(),
      )
      session.activity = `net_dash.py ${target.ip}`
      session.write(`${pingCommand(target)}\r`)
      this.sessions.set(session.id, session)
      this.pingTerminals.set(target.key, { name: target.name, ip: target.ip, session })
      changed = true
    }
    if (changed) this.changed()
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Terminals, the relay and the ALOHA's bridge

  private shell(robot: Robot, role: 'robot' | 'laptop' | 'nav'): TerminalSession {
    const current = robot.sessions[role]
    if (current && !current.exited) return current
    if (current) this.sessions.delete(current.id)
    const session = new TerminalSession(
      { id: `${robot.stored.id}-${role}-${++this.sessionCount}`, robot: robot.stored.id, role, cwd: this.packageRoot, cols: 160, rows: 40 },
      () => {
        if (role === RELAY_ROLE[robot.stored.kind] && session.exited && robot.relay.state === 'running') this.setRelay(robot, 'exited')
        if (role === 'nav' && session.exited && robot.nav.state === 'running') this.setNav(robot, 'exited')
        this.changed()
      },
    )
    robot.sessions[role] = session
    this.sessions.set(session.id, session)
    this.changed()
    return session
  }

  private setRelay(robot: Robot, state: RelayState, rateHz?: number | null): void {
    const old = robot.relay
    robot.relay = {
      state,
      since: state === old.state ? old.since : Date.now(),
      rateHz: rateHz !== undefined ? rateHz : state === 'running' ? old.rateHz : null,
    }
    this.changed()
  }

  private setNav(robot: Robot, state: RelayState): void {
    robot.nav = { state, since: state === robot.nav.state ? robot.nav.since : Date.now() }
    this.changed()
  }

  /** The nav bridge ends when its terminal gives the prompt back (Ctrl+C, a crash) or the terminal ends */
  private watchNav(robot: Robot, from: number): void {
    robot.navWatch?.abort()
    const watch = new AbortController()
    robot.navWatch = watch
    const shell = robot.sessions.nav
    if (!shell) return
    shell
      .waitFor((t) => (promptAtEnd(afterEcho(t)) ? true : null), { from, timeoutMs: null, signal: watch.signal, what: 'the nav bridge to end' })
      .then(() => this.setNav(robot, 'exited'))
      .catch((error: unknown) => {
        if (error instanceof ShellExited) this.setNav(robot, 'exited')
      })
  }

  /** Stops the nav bridge this server started (Ctrl+C); one kept from before stays */
  private async stopNav(robot: Robot): Promise<void> {
    robot.navWatch?.abort()
    robot.navWatch = null
    const shell = robot.sessions.nav
    if (shell && !shell.exited && (robot.nav.state === 'running' || robot.nav.state === 'starting')) await settle(shell, undefined, 300).catch(() => shell.kill())
    if (robot.nav.state !== 'none') this.setNav(robot, robot.nav.state === 'kept' ? 'none' : 'exited')
  }

  /** The relay (or bridge) ends when its terminal gives the prompt back (Ctrl+C, a crash) or the terminal ends */
  private watchRelay(robot: Robot, from: number): void {
    robot.relayWatch?.abort()
    const watch = new AbortController()
    robot.relayWatch = watch
    const shell = robot.sessions[RELAY_ROLE[robot.stored.kind]]
    if (!shell) return
    shell
      .waitFor((t) => (promptAtEnd(afterEcho(t)) ? true : null), { from, timeoutMs: null, signal: watch.signal, what: 'the relay to end' })
      .then(() => this.setRelay(robot, 'exited'))
      .catch((error: unknown) => {
        if (error instanceof ShellExited) this.setRelay(robot, 'exited')
      })
  }

  /** Stops what this server started, as you would by hand: an M20's relay (Ctrl+C, then exit back to this workstation);
   * the ALOHA's bridge (Ctrl+C), detaching from its tmux, which keeps running */
  private async stopRelay(robot: Robot): Promise<void> {
    robot.relayWatch?.abort()
    robot.relayWatch = null
    const shell = robot.sessions.robot
    if (robot.stored.kind === 'aloha') {
      const laptop = robot.sessions.laptop
      if (laptop && !laptop.exited && robot.relay.state !== 'kept' && robot.relay.state !== 'none') await settle(laptop, undefined, 300).catch(() => laptop.kill())
      if (shell && !shell.exited) await leaveAloha(shell, this.laptopHost).catch(() => shell.kill())
    } else if (shell && !shell.exited) {
      try {
        await leaveRobot(shell, this.laptopHost)
      } catch {
        shell.kill()
      }
    }
    if (robot.relay.state !== 'none') this.setRelay(robot, robot.relay.state === 'kept' ? 'none' : 'exited')
  }

  /** Removing the ALOHA stops what start_aloha.sh started: `bash start_aloha.sh stop` on the robot, logging in for it */
  private async stopAlohaStack(robot: Robot): Promise<void> {
    if (!(await answers(robot.stored.ip, 22))) return
    const shell = this.shell(robot, 'robot')
    await detachTmux(shell)
    const prompt = await settle(shell, undefined, 3000)
    if (placeOf(prompt, this.laptopHost) === 'laptop') {
      const scratch = pendingAlohaStep('login', robot.stored)
      const ctx: LoginContext = {
        ...this.loginParts(robot, new AbortController().signal),
        step: () => scratch,
        // Nobody is asked while a robot is removed
        ask: () => Promise.reject(new Aborted()),
      }
      await logIn(ctx, 'login', shell, command(README.ssh(robot.stored.ip, robot.stored.user), 'laptop'), null)
    }
    const from = shell.mark()
    shell.write(`${ALOHA.stop}\r`)
    await shell.waitFor((t) => promptAtEnd(afterEcho(t)), { from, timeoutMs: 60_000, what: 'start_aloha.sh to stop' })
    await leaveRobot(shell, this.laptopHost)
  }

  private async closeSessions(robot: Robot): Promise<void> {
    await this.stopRelay(robot)
    await this.stopNav(robot)
    for (const role of ['robot', 'laptop', 'nav'] as const) {
      const session = robot.sessions[role]
      if (!session) continue
      if (role === 'laptop' && !session.exited) session.interrupt()
      session.kill()
      this.sessions.delete(session.id)
      robot.sessions[role] = null
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // What a run needs

  /** The login's part of a run: the robot, its password as saved now, the operator and the step facts */
  private loginParts(robot: Robot, signal: AbortSignal): LoginContext {
    const { id, ip, user } = robot.stored
    const step = (key: SetupStepKey) => robot.steps.find((s) => s.key === key)!
    return {
      robot: { id, ip, user },
      password: () => robot.stored.password,
      laptopHost: this.laptopHost,
      signal,
      step,
      changed: () => this.changed(),
      ask: (key, prompt) =>
        new Promise<PromptChoice>((resolve, reject) => {
          if (signal.aborted) return reject(new Aborted())
          const s = step(key)
          s.status = 'decision'
          s.prompt = prompt
          robot.run = { ...robot.run, state: 'waiting' }
          const onAbort = () => {
            robot.answer = null
            reject(new Aborted())
          }
          signal.addEventListener('abort', onAbort, { once: true })
          robot.answer = {
            key,
            resolve: (choice) => {
              signal.removeEventListener('abort', onAbort)
              robot.answer = null
              s.status = 'active'
              s.prompt = null
              robot.run = { ...robot.run, state: 'running' }
              this.changed()
              resolve(choice)
            },
          }
          this.changed()
        }),
      setActivity: (role, activity) => {
        if (role === 'robot' || role === 'laptop' || role === 'nav') robot.sessions[role]?.setActivity(activity)
      },
    }
  }

  private sleeper(signal: AbortSignal): (ms: number) => Promise<void> {
    return (ms) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms)
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            reject(new Aborted())
          },
          { once: true },
        )
      })
  }

  private m20ContextFor(robot: Robot, signal: AbortSignal): M20SetupContext {
    const { id } = robot.stored
    const parts = this.loginParts(robot, signal)
    return {
      ...parts,
      robotShell: (): Shell => this.shell(robot, 'robot'),
      laptopShell: (): Shell => this.shell(robot, 'laptop'),
      updatePrompt: (key, prompt) => {
        const s = parts.step(key)
        if (s.status !== 'decision') return
        s.prompt = prompt
        this.changed()
      },
      setRelay: (state, rateHz) => this.setRelay(robot, state, rateHz),
      relayLaunched: (from) => this.watchRelay(robot, from),
      odomPublishers: () => odomPublishers(id, this.packageRoot),
      watchInitialPose: (onPose) => watchInitialPose(id, this.packageRoot, onPose),
      writeRvizConfig: () => void writeRobotRviz(id),
      navShell: (): Shell => this.shell(robot, 'nav'),
      setNav: (state) => this.setNav(robot, state),
      navLaunched: (from) => this.watchNav(robot, from),
      goalListeners: () => goalListeners(id, this.packageRoot),
      sleep: this.sleeper(signal),
    }
  }

  private alohaContextFor(robot: Robot, signal: AbortSignal): AlohaSetupContext {
    const parts = this.loginParts(robot, signal)
    return {
      ...parts,
      robotShell: (): Shell => this.shell(robot, 'robot'),
      laptopShell: (): Shell => this.shell(robot, 'laptop'),
      // The ALOHA has no nav bridge: its third terminal is the RViz it is localized in
      rvizShell: (): Shell => this.shell(robot, 'nav'),
      writeRvizConfig: () => void writeAlohaRviz(),
      watchInitialPose: (onPose) => watchAlohaInitialPose(this.packageRoot, onPose),
      watchAmclPose: (onPose) => watchAmclPose(this.packageRoot, onPose),
      updatePrompt: (key, prompt) => {
        const s = parts.step(key)
        if (s.status !== 'decision') return
        s.prompt = prompt
        this.changed()
      },
      setRelay: (state, rateHz) => this.setRelay(robot, state, rateHz),
      bridgeLaunched: (from) => this.watchRelay(robot, from),
      masterState: () => masterSystemState(robot.stored.ip),
      domainTopics: () => domainTopics(1, this.packageRoot),
      topicRate: (topic) => topicRate(1, topic, this.packageRoot),
      sleep: this.sleeper(signal),
    }
  }

  // -------------------------------------------------------------------------------------------------------------------

  /** Stops every run, relay and bridge this server started, closes rviz2, the recorder and the terminals: within about
   * `budgetMs`. The ALOHA's tmux session keeps running, as start_aloha.sh means it to. */
  async shutdown(budgetMs = 8000): Promise<void> {
    this.closing = true
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.presence.stop()
    this.plans.close()
    const robots = [...this.robots.values()]
    const tidy = Promise.all([
      this.mission.shutdown(),
      this.recorder.cancel(),
      this.closeRviz(),
      ...robots.map(async (robot) => {
        await this.stopRun(robot)
        await this.closeSessions(robot)
      }),
    ])
    await Promise.race([tidy, new Promise((resolve) => setTimeout(resolve, budgetMs))])
    for (const session of this.sessions.values()) session.kill()
    for (const client of this.clients) client.ws.close(1001, 'The setup server stopped')
  }
}

