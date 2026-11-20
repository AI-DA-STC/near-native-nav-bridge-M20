import type { RelayState, SetupStepFacts, SetupStepKey, StepCheck, StepCommand } from '../src/shared/api/setup-protocol.ts'
import { afterEcho, lastLine } from './command-output.ts'
import { ALOHA, README } from './readme-commands.ts'
import type { SystemState } from './ros1-master.ts'
import { placeOf, promptAtEnd } from './shell-prompt.ts'
import { Aborted, WaitTimeout, type Shell } from './shell-transcript.ts'
import { leaveRobot, logIn, type LoginContext, type RobotLogin } from './ssh-login.ts'
import { StepFailed, command, fail, runSteps, settle, typeChecked } from './step-shell.ts'

/* The Mobile ALOHA's setup: ssh in as its user, run its own `bash start_aloha.sh` (roscore, the cameras, the Piper arms,
 * the lidar, the base, navigation, stream.launch and dock.py, one tmux window each), check each of them on its ROS
 * master, then bridge its topics to ROS_DOMAIN_ID=1 here with aloha/bridge.sh. No localization: its map is its own. */

export const ALOHA_STEPS: readonly SetupStepKey[] = ['login', 'start', 'stack', 'bridge']

/** What start_aloha.sh starts, one tmux window each, and the topics that say it is up: each needs a publisher */
export const ALOHA_STACK: ReadonlyArray<{ window: string; label: string; topics: readonly string[] }> = [
  { window: 'roscore', label: 'roscore', topics: ['/rosout_agg'] },
  { window: 'cameras', label: 'Cameras', topics: ['f', 'l', 'r'].map((c) => `/camera_${c}/color/image_raw/compressed`) },
  { window: 'arms', label: 'Piper arms', topics: ['/puppet/joint_left', '/puppet/joint_right'] },
  { window: 'lidar', label: 'Lidar', topics: ['/scan'] },
  { window: 'base', label: 'Base', topics: ['/odom'] },
  { window: 'navigation', label: 'Navigation', topics: ['/move_base/status', '/amcl_pose', '/map'] },
  { window: 'stream', label: 'stream.launch', topics: ['f', 'l', 'r'].map((c) => `/camera_${c}/color/image_throttled/compressed`) },
  { window: 'dock', label: 'dock.py', topics: ['/aloha/dock/result'] },
]

/** Bridged to ROS_DOMAIN_ID=1 by aloha/bridge.sh (bridge.yaml), and what has to stream through it */
const BRIDGED = ['/scan', '/map', '/move_base/status', '/puppet/joint_left', '/aloha/dock/result']
const BRIDGE_DOMAIN = 1
const BRIDGING = /create bidirectional bridge for topic|created \dto\d bridge for topic|Passing message from ROS 1/
const STACK_PATIENCE_MS = 90_000

export interface AlohaSetupContext extends LoginContext {
  /** The robot terminal: ssh, then start_aloha.sh's tmux */
  robotShell(): Shell
  /** The laptop terminal: aloha/bridge.sh */
  laptopShell(): Shell
  setRelay(state: RelayState, rateHz?: number | null): void
  /** The bridge was launched in the laptop terminal at this position: watch it from there */
  bridgeLaunched(from: number): void
  /** The ALOHA's ROS master's topics; rejects when it does not answer */
  masterState(): Promise<SystemState>
  /** On ROS_DOMAIN_ID=1, here */
  domainTopics(): Promise<string[]>
  topicRate(topic: string): Promise<number | null>
  sleep(ms: number): Promise<void>
}

export function alohaScriptOf(key: SetupStepKey, robot: RobotLogin): SetupStepFacts['commands'] {
  switch (key) {
    case 'login':
      return [command(README.ssh(robot.ip, robot.user), 'laptop')]
    case 'start':
      return [command(ALOHA.start, 'robot')]
    case 'bridge':
      return [command(README.exportProfile, 'laptop'), command(ALOHA.bridge, 'laptop')]
    default:
      return []
  }
}

export function pendingAlohaStep(key: SetupStepKey, robot: RobotLogin): SetupStepFacts {
  return {
    key,
    status: 'pending',
    detail: '',
    startedAt: null,
    endedAt: null,
    commands: alohaScriptOf(key, robot),
    checks: [],
    prompt: null,
    error: null,
  }
}

export async function runAlohaSetup(ctx: AlohaSetupContext, from: SetupStepKey = 'login'): Promise<void> {
  await runSteps(ctx, ALOHA_STEPS, { login, start, stack, bridge }, (key) => pendingAlohaStep(key, ctx.robot), from)
}

// ---------------------------------------------------------------------------------------------------------------------
// tmux, as start_aloha.sh leaves the robot terminal

const TMUX_STATUS = /\[aloha\] *\d+:[\w.-]/g
const TMUX_LEFT = /\[detached \(from session aloha\)\]|\[exited\]|\[server exited\]|\[lost tty\]/g

function lastMatch(text: string, pattern: RegExp): number {
  let at = -1
  for (const m of text.matchAll(pattern)) at = m.index
  return at
}

/** The terminal shows start_aloha.sh's tmux session (its status line came after any detach) */
export function tmuxAttached(text: string): boolean {
  const status = lastMatch(text, TMUX_STATUS)
  return status !== -1 && status > lastMatch(text, TMUX_LEFT) && !promptAtEnd(text)
}

/** Detaches from the tmux session (Ctrl+b d), which keeps running, as you would: Ctrl+C would stop roscore */
export async function detachTmux(shell: Shell, signal?: AbortSignal): Promise<void> {
  if (!tmuxAttached(shell.textSince(shell.mark() - 64 * 1024))) return
  const from = shell.mark()
  shell.write(ALOHA.detach)
  await shell.waitFor(promptAtEnd, { from, timeoutMs: 10_000, signal, what: 'the prompt after detaching from tmux' })
}

/** Back to this workstation's prompt from the robot terminal: detaches from tmux first, so the stack keeps running */
export async function leaveAloha(shell: Shell, laptopHost: string, signal?: AbortSignal): Promise<void> {
  await detachTmux(shell, signal)
  await leaveRobot(shell, laptopHost, signal)
}

// ---------------------------------------------------------------------------------------------------------------------
// The steps

/** Log in from this workstation's prompt, as its user (agilex) */
async function login(ctx: AlohaSetupContext) {
  const shell = ctx.robotShell()
  await detachTmux(shell, ctx.signal)
  const prompt = await settle(shell, ctx.signal)
  if (placeOf(prompt, ctx.laptopHost) !== 'laptop') await leaveRobot(shell, ctx.laptopHost, ctx.signal)
  const step = ctx.step('login')
  const [sshCmd] = step.commands
  await logIn(ctx, 'login', shell, sshCmd, null)
  step.detail = `Logged in as ${ctx.robot.user} on ${ctx.robot.ip}`
}

/** a. start_aloha.sh: everything in tmux, then it attaches (or finds it already running) */
async function start(ctx: AlohaSetupContext) {
  const shell = ctx.robotShell()
  const step = ctx.step('start')
  await detachTmux(shell, ctx.signal)
  const prompt = await settle(shell, ctx.signal)
  if (placeOf(prompt, ctx.laptopHost) === 'laptop') throw new StepFailed('The robot terminal is not logged in to the ALOHA: run its setup again')

  let startCmd = step.commands[0]
  for (;;) {
    const outcome = await launch(ctx, shell, startCmd)
    if (outcome.kind === 'attached') {
      startCmd.status = 'done'
      startCmd.note = 'tmux session aloha, attached'
      step.detail = 'start_aloha.sh runs each part in a tmux window: see them under Terminals'
      ctx.setActivity('robot', 'tmux attach -t aloha')
      ctx.changed()
      return
    }
    if (outcome.kind === 'failed') throw fail(startCmd, outcome.line)
    // Already running: start_aloha.sh refuses to start it twice
    startCmd.status = 'failed'
    startCmd.note = 'already running'
    ctx.changed()
    const choice = await ctx.ask('start', { kind: 'aloha-running' })
    if (choice === 'keep-aloha') {
      startCmd.status = 'skipped'
      startCmd.note = 'kept the session already running'
      ctx.setActivity('robot', 'bash')
      step.detail = 'Kept start_aloha.sh’s session already running (tmux attach -t aloha shows it)'
      ctx.changed()
      return
    }
    if (choice !== 'restart-aloha') throw new Aborted()
    // Its stop Ctrl+Cs every window and waits up to 30 s for them, then stops roscore
    const stopCmd = command(ALOHA.stop, 'robot')
    step.commands.push(stopCmd)
    await typeChecked(ctx, shell, stopCmd, 90_000)
    stopCmd.note = 'stopped'
    startCmd = command(ALOHA.start, 'robot')
    step.commands.push(startCmd)
  }
}

type Launched = { kind: 'attached' } | { kind: 'already' } | { kind: 'failed'; line: string }

/** Types start_aloha.sh and reads how it went: tmux attached once roscore answers, or its own refusal */
async function launch(ctx: AlohaSetupContext, shell: Shell, cmd: StepCommand): Promise<Launched> {
  cmd.status = 'running'
  cmd.note = null
  ctx.setActivity('robot', cmd.text)
  ctx.changed()
  const from = shell.mark()
  shell.write(`${cmd.text}\r`)
  const deadline = Date.now() + 90_000
  for (;;) {
    const said = afterEcho(shell.textSince(from))
    if (/Already running/.test(said)) {
      await shell.waitFor((t) => promptAtEnd(afterEcho(t)), { from, timeoutMs: 15_000, signal: ctx.signal, what: 'the prompt after start_aloha.sh' })
      return { kind: 'already' }
    }
    const refused = /^.*(?:A ROS master is already running|roscore did not start|Needs tmux).*$/m.exec(said)?.[0].trim()
    if (refused) return { kind: 'failed', line: refused }
    if (tmuxAttached(said)) {
      try {
        await ctx.masterState()
        return { kind: 'attached' }
      } catch {
        // roscore does not answer yet
      }
    } else if (promptAtEnd(said)) {
      return { kind: 'failed', line: lastLine(said.slice(0, said.lastIndexOf('\n'))) ?? 'start_aloha.sh ended' }
    }
    if (Date.now() > deadline) return { kind: 'failed', line: 'start_aloha.sh did not open its tmux session in 90 s' }
    try {
      await shell.waitFor(() => null, { from: shell.mark(), timeoutMs: 1000, signal: ctx.signal, what: 'start_aloha.sh' })
    } catch (error) {
      if (!(error instanceof WaitTimeout)) throw error
    }
  }
}

/** b. Each part start_aloha.sh starts is up: its topics have a publisher on the ALOHA's master */
async function stack(ctx: AlohaSetupContext) {
  const step = ctx.step('stack')
  step.checks = ALOHA_STACK.map((part) => ({ label: part.label, ok: null, value: null }))
  step.detail = 'Asking the ALOHA’s ROS master'
  ctx.changed()
  const deadline = Date.now() + STACK_PATIENCE_MS
  for (;;) {
    let state: SystemState | null = null
    try {
      state = await ctx.masterState()
    } catch {
      state = null
    }
    step.checks = stackChecks(state)
    const up = step.checks.filter((c) => c.ok).length
    step.detail = state ? `${up} of ${ALOHA_STACK.length} up` : `No answer from the ROS master at ${ctx.robot.ip}:11311`
    ctx.changed()
    if (up === ALOHA_STACK.length) {
      step.detail = `All ${ALOHA_STACK.length} up on the ALOHA’s ROS master`
      return
    }
    if (Date.now() > deadline) {
      const down = step.checks.filter((c) => !c.ok).map((c) => c.label)
      throw new StepFailed(`Not up after ${STACK_PATIENCE_MS / 1000} s: ${down.join(', ')}. Their tmux windows show why (Terminals).`)
    }
    await ctx.sleep(2000)
  }
}

/** A node's name without the suffix of an anonymous one (`anonymous=True` adds _<host>_<pid>_<random>) */
export function shortNode(name: string): string {
  return name.replace(/_[A-Za-z0-9-]+_\d+_\d{8,}$/, '')
}

/** One check per part: ok when every one of its topics has a publisher; the value names who publishes, or what is
 * missing */
export function stackChecks(state: SystemState | null): StepCheck[] {
  return ALOHA_STACK.map((part) => {
    if (!state) return { label: part.label, ok: part.window === 'roscore' ? false : null, value: part.window === 'roscore' ? 'no answer' : null }
    const missing = part.topics.filter((t) => !(state.publishers.get(t)?.length ?? 0))
    if (missing.length) return { label: part.label, ok: false, value: `no ${missing[0]}${missing.length > 1 ? ` (+${missing.length - 1})` : ''}` }
    const nodes = [...new Set(part.topics.flatMap((t) => state.publishers.get(t) ?? []).map(shortNode))]
    return { label: part.label, ok: true, value: nodes.slice(0, 2).join(', ') + (nodes.length > 2 ? ` +${nodes.length - 2}` : '') }
  })
}

/** c. aloha/bridge.sh here: the ALOHA's topics on ROS_DOMAIN_ID=1, streaming */
async function bridge(ctx: AlohaSetupContext) {
  const shell = ctx.laptopShell()
  const step = ctx.step('bridge')
  const [profileCmd, bridgeCmd] = step.commands
  await settle(shell, ctx.signal)

  // A bridge already running (by hand, or left over) would send everything twice
  const before = await ctx.domainTopics()
  if (before.includes('/scan')) {
    profileCmd.status = 'skipped'
    bridgeCmd.status = 'skipped'
    bridgeCmd.note = 'a bridge already runs on ROS_DOMAIN_ID=1'
    ctx.setRelay('kept')
    step.detail = 'Kept the bridge already running on ROS_DOMAIN_ID=1 (its output is not in this console)'
    ctx.changed()
    return
  }

  await typeChecked(ctx, shell, profileCmd, 15_000)
  bridgeCmd.status = 'running'
  step.detail = 'Starting the bridge'
  ctx.setRelay('starting')
  ctx.setActivity('laptop', ALOHA.bridge)
  ctx.changed()
  const from = shell.mark()
  shell.write(`${bridgeCmd.text}\r`)
  const ended = (t: string) => promptAtEnd(afterEcho(t)) !== null
  try {
    // parameter_bridge says "create bidirectional bridge for topic /scan" per topic, then "Passing message from ROS 1 …"
    await shell.waitFor((t) => (BRIDGING.test(t) || ended(t) ? true : null), {
      from,
      timeoutMs: 45_000,
      signal: ctx.signal,
      what: 'aloha/bridge.sh to bridge its first topic',
    })
  } catch (error) {
    if (!(error instanceof WaitTimeout)) throw error
  }
  if (ended(shell.textSince(from))) {
    ctx.setRelay('exited')
    throw fail(bridgeCmd, lastLine(afterEcho(shell.textSince(from)).split('\n').slice(0, -1).join('\n')) ?? 'aloha/bridge.sh ended')
  }
  ctx.bridgeLaunched(from)

  step.checks = BRIDGED.map((label) => ({ label, ok: null, value: null }))
  step.detail = `Waiting for the ALOHA’s topics on ROS_DOMAIN_ID=${BRIDGE_DOMAIN}`
  ctx.changed()
  const deadline = Date.now() + 40_000
  for (;;) {
    const listed = new Set(await ctx.domainTopics())
    step.checks = BRIDGED.map((label) => ({ label, ok: listed.has(label), value: null }))
    ctx.changed()
    if (BRIDGED.every((t) => listed.has(t))) break
    if (ended(shell.textSince(from))) throw fail(bridgeCmd, 'aloha/bridge.sh ended')
    if (Date.now() > deadline) {
      const missing = BRIDGED.filter((t) => !listed.has(t))
      throw fail(bridgeCmd, `Not on ROS_DOMAIN_ID=${BRIDGE_DOMAIN} after 40 s: ${missing.join(', ')}`)
    }
    await ctx.sleep(2000)
  }

  step.detail = 'Measuring /scan through the bridge'
  ctx.changed()
  const rate = await ctx.topicRate('/scan')
  step.checks.push({ label: '/scan rate', ok: rate !== null && rate > 0, value: rate === null ? 'nothing in 8 s' : `${rate.toFixed(1)} Hz` })
  if (rate === null || rate <= 0) throw fail(bridgeCmd, `No /scan on ROS_DOMAIN_ID=${BRIDGE_DOMAIN}: is the lidar up?`)
  // aloha/bridge.sh checks that the robot can connect back, for the goals and arm commands that go to it
  const firewalled = /the robot cannot connect back to this laptop/.test(shell.textSince(from))
  step.checks.push({ label: 'ALOHA connects back here', ok: !firewalled, value: firewalled ? 'blocked: sudo ufw allow from the ALOHA' : 'yes' })
  bridgeCmd.status = 'done'
  bridgeCmd.note = `/scan at ${rate.toFixed(1)} Hz`
  ctx.setRelay('running', rate)
  step.detail = firewalled
    ? `Bridged, but the ALOHA cannot connect back: goals and arm commands will not reach it (sudo ufw allow from ${ctx.robot.ip}, on the host)`
    : `ROS_DOMAIN_ID=${BRIDGE_DOMAIN} · /scan at ${rate.toFixed(1)} Hz`
}
