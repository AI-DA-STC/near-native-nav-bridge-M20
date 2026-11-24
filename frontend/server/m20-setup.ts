import type { PoseFact, RelayState, SetupPrompt, SetupStepFacts, SetupStepKey } from '../src/shared/api/setup-protocol.ts'
import { afterEcho, errorLine, hzRates, lastLine, pullOutcome, relayLaunch, topicsListed } from './command-output.ts'
import { LAUNCH_NODE_COUNT, README, RECOVERY, REGISTRY, relayedTopics, rvizWithConfig } from './readme-commands.ts'
import { rvizConfigPath } from './rviz-config.ts'
import { placeOf, promptAtEnd, type ShellPrompt } from './shell-prompt.ts'
import { Aborted, WaitTimeout, type Shell } from './shell-transcript.ts'
import { leaveRobot, logIn, su, type LoginContext, type RobotLogin } from './ssh-login.ts'
import { StepFailed, command, fail, runSteps, settle, type, typeChecked } from './step-shell.ts'

/* An M20's setup: the README's robot-side and laptop-side steps, typed into two terminals as you would type them, in
 * order. Each command is typed once the shell's prompt is back; what it printed says whether it worked. A step that
 * needs the operator (the registry, a relay already running, the localization) shows a prompt and waits. */

export const M20_STEPS: readonly SetupStepKey[] = ['login', 'image', 'relay', 'laptop', 'topics', 'localize', 'nav']

export { StepFailed }

/** What a run needs from the hub: the terminals, the step facts, the operator, and the checks it cannot type */
export interface M20SetupContext extends LoginContext {
  /** The robot terminal: the shell that sshes into the robot and runs its relay */
  robotShell(): Shell
  /** The laptop terminal: exports, topic checks, rviz2 */
  laptopShell(): Shell
  /** Replaces the prompt shown while it waits */
  updatePrompt(key: SetupStepKey, prompt: SetupPrompt): void
  setRelay(state: RelayState, rateHz?: number | null): void
  /** The relay was launched in the robot terminal at this position: watch it from there */
  relayLaunched(from: number): void
  odomPublishers(): Promise<number | null>
  watchInitialPose(onPose: (pose: PoseFact) => void): () => void
  /** Writes the robot's RViz config (rviz-config.ts) before rviz2 is typed */
  writeRvizConfig(): void
  /** The nav terminal: this robot's nav bridge */
  navShell(): Shell
  setNav(state: RelayState): void
  /** The nav bridge was launched in the nav terminal at this position: watch it from there */
  navLaunched(from: number): void
  /** How many listen on /goal_pose_<id> already: a nav bridge started by hand. null: could not tell. */
  goalListeners(): Promise<number | null>
  sleep(ms: number): Promise<void>
}

/** The commands a step types, verbatim from README.md, before it runs */
export function scriptOf(key: SetupStepKey, robot: RobotLogin): SetupStepFacts['commands'] {
  switch (key) {
    case 'login':
      return [command(README.ssh(robot.ip, robot.user), 'laptop'), command(README.su, 'robot')]
    case 'image':
      return [command(README.pull, 'robot'), command(README.tag, 'robot')]
    case 'relay':
      return [
        command(README.composeUp, 'robot'),
        command(README.composeExec, 'robot'),
        command(README.exportRobotId(robot.id), 'container'),
        command(README.exportDomain, 'container'),
        command(README.launchRelays, 'container'),
      ]
    case 'laptop':
      return [command(README.exportDomain, 'laptop'), command(README.exportProfile, 'laptop'), command(README.sourceInstall, 'laptop')]
    case 'topics':
      return [command(README.topicList, 'laptop'), command(README.topicHz(robot.id), 'laptop')]
    case 'localize':
      return [command(rvizWithConfig(robot.id, rvizConfigPath(robot.id)), 'laptop')]
    case 'nav':
      return [
        command(README.exportDomain, 'laptop'),
        command(README.exportProfile, 'laptop'),
        command(README.sourceInstall, 'laptop'),
        command(README.exportRobotId(robot.id), 'laptop'),
        command(README.navBridge(robot.ip), 'laptop'),
      ]
    default:
      return []
  }
}


export function pendingStep(key: SetupStepKey, robot: RobotLogin): SetupStepFacts {
  return {
    key,
    status: 'pending',
    detail: '',
    startedAt: null,
    endedAt: null,
    commands: scriptOf(key, robot),
    checks: [],
    prompt: null,
    error: null,
  }
}

/** Runs the steps from `from` to the end. A failure marks its step and throws; Aborted means the operator stopped. */
export async function runM20Setup(ctx: M20SetupContext, from: SetupStepKey = 'login'): Promise<void> {
  await runSteps(ctx, M20_STEPS, { login, image, relay, laptop, topics, localize, nav }, (key) => pendingStep(key, ctx.robot), from)
}

// ---------------------------------------------------------------------------------------------------------------------
// A root shell on the robot

/** A root shell on the robot, whatever the robot terminal shows now: leaves the container, or logs in again (the login's
 * commands then show in this step too) */
async function ensureRobotRoot(ctx: M20SetupContext, key: SetupStepKey): Promise<ShellPrompt> {
  const shell = ctx.robotShell()
  for (let i = 0; i < 5; i++) {
    const prompt = await settle(shell, ctx.signal)
    const place = placeOf(prompt, ctx.laptopHost)
    if (place === 'robot-root') return prompt
    if (place === 'container') {
      const from = shell.mark()
      shell.write('exit\r')
      await shell.waitFor((t) => promptAtEnd(afterEcho(t)), { from, timeoutMs: 15_000, signal: ctx.signal, what: 'a prompt after exit' })
      continue
    }
    const step = ctx.step(key)
    const suCmd = command(README.su, 'robot')
    if (place === 'laptop') {
      const sshCmd = command(README.ssh(ctx.robot.ip, ctx.robot.user), 'laptop')
      step.commands.unshift(sshCmd, suCmd)
      await logIn(ctx, key, shell, sshCmd, suCmd)
    } else {
      step.commands.unshift(suCmd)
      await su(ctx, shell, suCmd)
    }
  }
  throw new StepFailed('Could not get a root shell on the robot')
}

// ---------------------------------------------------------------------------------------------------------------------
// The steps

/** Log in: from this workstation's prompt, as the README's robot-side Step 2 and the first line of Step 3 */
async function login(ctx: M20SetupContext) {
  const shell = ctx.robotShell()
  const prompt = await settle(shell, ctx.signal)
  // An earlier run left the terminal on the robot: back to this workstation, so the login is the README's
  if (placeOf(prompt, ctx.laptopHost) !== 'laptop') await leaveRobot(shell, ctx.laptopHost, ctx.signal)
  const step = ctx.step('login')
  const [sshCmd, suCmd] = step.commands
  await logIn(ctx, 'login', shell, sshCmd, suCmd)
  step.detail = `Root shell on ${ctx.robot.ip}`
}

/** a. Pull and tag the latest image on the robot's motion host */
async function image(ctx: M20SetupContext) {
  const shell = ctx.robotShell()
  await ensureRobotRoot(ctx, 'image')
  const step = ctx.step('image')
  const pullCmd = step.commands.find((c) => c.text === README.pull)!
  const tagCmd = step.commands.find((c) => c.text === README.tag)!
  for (;;) {
    step.detail = `Pulling from ${REGISTRY}`
    const { output } = await type(ctx, shell, pullCmd, 15 * 60_000)
    const pulled = pullOutcome(output)
    if (pulled.ok) {
      pullCmd.status = 'done'
      pullCmd.note = pulled.updated ? 'newer image pulled' : 'up to date'
      break
    }
    pullCmd.status = 'failed'
    pullCmd.note = pulled.error
    const choice = await ctx.ask(
      'image',
      pulled.insecureRegistry ? { kind: 'registry', registry: REGISTRY, error: pulled.error } : { kind: 'pull-failed', error: pulled.error },
    )
    if (choice === 'skip') {
      // The tag only renames a pulled image: without the pull, the robot keeps the m20-bridge:foxy it has
      pullCmd.status = 'skipped'
      pullCmd.note = 'kept the image on the robot'
      tagCmd.status = 'skipped'
      step.detail = 'Kept the image already on the robot'
      ctx.changed()
      return
    }
    if (choice !== 'retry') throw new Aborted()
    // You may have used the terminal meanwhile (daemon.json, docker restart): back to a root shell first
    await ensureRobotRoot(ctx, 'image')
  }
  await typeChecked(ctx, shell, tagCmd, 60_000)
  tagCmd.note = 'm20-bridge:foxy'
  step.detail = `${pullCmd.note === 'up to date' ? 'Image up to date' : 'Pulled a newer image'}, tagged m20-bridge:foxy`
}

/** b. Start the container and the relays in it, with this robot's ID */
async function relay(ctx: M20SetupContext) {
  const shell = ctx.robotShell()
  const step = ctx.step('relay')
  const topic = relayedTopics(ctx.robot.id).own[0]
  // Started now, answered while compose runs: a relay already publishing would double every topic
  const publishersBefore = ctx.odomPublishers()
  await ensureRobotRoot(ctx, 'relay')
  const [upCmd, execCmd, idCmd, domainCmd, launchCmd] = step.commands.slice(-5)

  const { output: upOutput } = await typeChecked(ctx, shell, upCmd, 180_000)
  upCmd.note = /Recreated?/.test(upOutput) ? 'recreated' : /Started|Starting/.test(upOutput) ? 'started' : /Running/.test(upOutput) ? 'running' : null

  const publishers = await publishersBefore
  step.checks = [{ label: `Publishers on ${topic} before the launch`, ok: publishers === null ? null : publishers === 0, value: publishers === null ? 'unknown' : String(publishers) }]
  ctx.changed()
  if (publishers) {
    const choice = await ctx.ask('relay', { kind: 'relay-running', topic, publishers })
    if (choice === 'keep-relay') {
      for (const c of [execCmd, idCmd, domainCmd, launchCmd]) c.status = 'skipped'
      ctx.setRelay('kept')
      step.detail = 'Kept the relay already running (its output is not in this console)'
      ctx.changed()
      return
    }
    if (choice !== 'restart-container') throw new Aborted()
    const restart = command(RECOVERY.restartContainer, 'robot')
    step.commands.splice(step.commands.indexOf(execCmd), 0, restart)
    await typeChecked(ctx, shell, restart, 180_000)
  }

  const { output: execOutput, prompt } = await type(ctx, shell, execCmd, 60_000)
  if (placeOf(prompt, ctx.laptopHost) !== 'container') {
    throw fail(execCmd, errorLine(execOutput) ?? lastLine(execOutput) ?? 'docker compose exec did not open a shell in the container')
  }
  execCmd.status = 'done'
  execCmd.note = `${prompt.user}@${prompt.host}:${prompt.cwd}`
  await typeChecked(ctx, shell, idCmd, 15_000)
  await typeChecked(ctx, shell, domainCmd, 15_000)

  launchCmd.status = 'running'
  step.detail = 'Launching the relays'
  ctx.setRelay('starting')
  ctx.setActivity('robot', launchCmd.text)
  ctx.changed()
  const from = shell.mark()
  shell.write(`${launchCmd.text}\r`)
  const ended = (t: string) => promptAtEnd(afterEcho(t)) !== null
  await shell.waitFor((t) => (/All log files can be found below|process started with pid/.test(t) || relayLaunch(t).fatal || ended(t) ? true : null), {
    from,
    timeoutMs: 60_000,
    signal: ctx.signal,
    what: 'output from ros2 launch',
  })
  // README: "wait for at least 5s for the above relay node to start"
  launchCmd.note = 'waiting 5 s'
  ctx.changed()
  try {
    await shell.waitFor((t) => (relayLaunch(t).fatal || relayLaunch(t).died || ended(t) ? true : null), {
      from,
      timeoutMs: 5000,
      signal: ctx.signal,
      what: 'a relay to fail',
    })
  } catch (error) {
    if (!(error instanceof WaitTimeout)) throw error
  }
  const launched = relayLaunch(shell.textSince(from))
  const problem = launched.fatal ?? launched.died ?? (ended(shell.textSince(from)) ? 'ros2 launch ended' : null)
  if (problem || launched.started === 0) {
    ctx.setRelay('exited')
    throw fail(launchCmd, problem ?? 'No relay started in 5 s')
  }
  launchCmd.status = 'done'
  launchCmd.note = `${launched.started} of ${LAUNCH_NODE_COUNT} relays started`
  ctx.setRelay('running')
  ctx.relayLaunched(from)
  step.detail = `relays.launch.py running as ROBOT_ID=${ctx.robot.id}, ${launched.started} of ${LAUNCH_NODE_COUNT} relays`
}

/** c. The laptop's ROS domain, Fast DDS profile and workspace, in the package root */
async function laptop(ctx: M20SetupContext) {
  const shell = ctx.laptopShell()
  const step = ctx.step('laptop')
  await settle(shell, ctx.signal)
  for (const cmd of step.commands) await typeChecked(ctx, shell, cmd, 30_000)
  step.detail = 'ROS_DOMAIN_ID=0 · fastdds_profile.xml · install/setup.bash'
}

/** d. Every topic the relays make for this robot is listed, and /ODOM_relayed_<id> streams */
async function topics(ctx: M20SetupContext) {
  const shell = ctx.laptopShell()
  const step = ctx.step('topics')
  await settle(shell, ctx.signal)
  const [listCmd, hzCmd] = step.commands
  const { own, shared } = relayedTopics(ctx.robot.id)
  const expected = [...own, ...shared]
  step.checks = expected.map((label) => ({ label, ok: null, value: null }))
  step.detail = 'Waiting for the topics to be discovered'
  const deadline = Date.now() + 25_000
  for (let attempt = 1; ; attempt++) {
    const { output } = await type(ctx, shell, listCmd, 30_000)
    const listed = new Set(topicsListed(output))
    const missing = expected.filter((t) => !listed.has(t))
    step.checks = expected.map((label) => ({ label, ok: listed.has(label), value: null }))
    listCmd.note = `${expected.length - missing.length} of ${expected.length} listed`
    if (!missing.length) {
      listCmd.status = 'done'
      break
    }
    if (Date.now() > deadline) {
      listCmd.status = 'failed'
      throw new StepFailed(`Not listed after ${attempt} tries: ${missing.join(', ')}`)
    }
    // The ros2 daemon caches what it discovered: one started before the relay can keep missing it
    if (attempt === 3) {
      const restart = command(RECOVERY.daemonStop, 'laptop')
      step.commands.splice(step.commands.indexOf(hzCmd), 0, restart)
      await typeChecked(ctx, shell, restart, 30_000)
    }
    listCmd.status = 'running'
    ctx.changed()
    await ctx.sleep(2000)
  }

  hzCmd.status = 'running'
  step.detail = `Measuring /ODOM_relayed_${ctx.robot.id}`
  ctx.setActivity('laptop', hzCmd.text)
  ctx.changed()
  const from = shell.mark()
  shell.write(`${hzCmd.text}\r`)
  let rates: number[]
  try {
    rates = (await shell.waitFor((t) => (hzRates(t).length >= 2 ? hzRates(t) : null), {
      from,
      timeoutMs: 15_000,
      signal: ctx.signal,
      what: `messages on /ODOM_relayed_${ctx.robot.id}`,
    })).value
  } catch (error) {
    if (!(error instanceof WaitTimeout)) throw error
    rates = hzRates(shell.textSince(from))
  }
  // Ctrl+C, as you would
  const stopFrom = shell.mark()
  shell.write('\x03')
  await shell.waitFor(promptAtEnd, { from: stopFrom, timeoutMs: 15_000, signal: ctx.signal, what: 'the prompt after Ctrl+C' })
  ctx.setActivity('laptop', 'bash')
  const rate = rates.at(-1)
  if (rate === undefined || rate <= 0) throw fail(hzCmd, `No messages on /ODOM_relayed_${ctx.robot.id} in 15 s`)
  hzCmd.status = 'done'
  hzCmd.note = `${rate.toFixed(1)} Hz`
  step.checks.push({ label: `/ODOM_relayed_${ctx.robot.id} rate`, ok: true, value: `${rate.toFixed(1)} Hz` })
  ctx.setRelay('running', rate)
  step.detail = `${expected.length} topics listed · /ODOM_relayed_${ctx.robot.id} at ${rate.toFixed(1)} Hz`
}

/** e. rviz2 on the robots' shared TF, with this robot's goal and initial pose topics: the operator localizes it */
async function localize(ctx: M20SetupContext) {
  const shell = ctx.laptopShell()
  const step = ctx.step('localize')
  const [rvizCmd] = step.commands
  let pose: PoseFact | null = null
  let rviz: 'running' | 'closed' = 'running'
  // Set by the watcher below, between awaits
  const rvizNow = () => rviz
  const scope = new AbortController()
  const onAbort = () => scope.abort()
  ctx.signal.addEventListener('abort', onAbort)
  const stopWatching = ctx.watchInitialPose((p) => {
    pose = p
    ctx.updatePrompt('localize', { kind: 'localize', rviz, pose })
  })
  try {
    for (;;) {
      if (rviz === 'running' && rvizCmd.status !== 'running') {
        await settle(shell, ctx.signal)
        // Fresh from the template every time: what RViz saved into it last time does not stick
        ctx.writeRvizConfig()
        rvizCmd.status = 'running'
        rvizCmd.note = null
        step.detail = 'RViz is open: set the 2D Pose Estimate'
        ctx.setActivity('laptop', 'rviz2')
        const from = shell.mark()
        shell.write(`${rvizCmd.text}\r`)
        // RViz closing gives the prompt back
        shell
          .waitFor((t) => (promptAtEnd(afterEcho(t)) ? true : null), { from, timeoutMs: null, signal: scope.signal, what: 'RViz to close' })
          .then(() => {
            rviz = 'closed'
            rvizCmd.status = 'done'
            rvizCmd.note = 'closed'
            ctx.setActivity('laptop', 'bash')
            ctx.updatePrompt('localize', { kind: 'localize', rviz, pose })
          })
          .catch(() => undefined)
      }
      const choice = await ctx.ask('localize', { kind: 'localize', rviz, pose })
      if (choice === 'localized') break
      if (choice === 'open-rviz') {
        if (rvizNow() === 'closed') rviz = 'running'
        continue
      }
      throw new Aborted()
    }
  } finally {
    scope.abort()
    ctx.signal.removeEventListener('abort', onAbort)
    stopWatching()
  }
  if (rvizCmd.status === 'running') rvizCmd.note = 'open'
  rvizCmd.status = 'done'
  const p = pose as PoseFact | null
  step.detail = p
    ? `Localized at x ${p.x.toFixed(2)}, y ${p.y.toFixed(2)}, heading ${Math.round(p.yaw)}°`
    : 'Localized (confirmed without a new pose estimate)'
}

/** How long the nav bridge has to say it listens */
const NAV_PATIENCE_MS = 30_000

/** f. README Multi-robot Step 1: this robot's nav bridge here, which run_demo.sh's goals go through. It moves nothing by
 * itself: it sends the robot a heartbeat every second until a goal arrives on /goal_pose_<id>. */
async function nav(ctx: M20SetupContext) {
  const shell = ctx.navShell()
  const step = ctx.step('nav')
  const exports = step.commands.slice(0, -1)
  const bridgeCmd = step.commands[step.commands.length - 1]
  const goals = `/goal_pose_${ctx.robot.id}`
  await settle(shell, ctx.signal)

  // One started by hand already listens: a second would drive every goal twice
  const listening = await ctx.goalListeners()
  if (listening) {
    for (const c of step.commands) c.status = 'skipped'
    bridgeCmd.note = `a bridge already listens on ${goals}`
    ctx.setNav('kept')
    step.detail = `Kept the nav bridge already listening on ${goals} (its output is not in this console)`
    ctx.changed()
    return
  }

  for (const c of exports) await typeChecked(ctx, shell, c, 30_000)
  bridgeCmd.status = 'running'
  step.detail = 'Starting the nav bridge'
  ctx.setNav('starting')
  ctx.setActivity('nav', bridgeCmd.text)
  ctx.changed()
  const from = shell.mark()
  shell.write(`${bridgeCmd.text}\r`)
  // "[goal_bridge_741]: Goals on /goal_pose_741, results on /goal_result_741, …" once it listens
  const listens = new RegExp(`Goals on ${goals.replaceAll('/', '\\/')}\\b`)
  const ended = (t: string) => promptAtEnd(afterEcho(t)) !== null
  try {
    await shell.waitFor((t) => (listens.test(t) || ended(t) ? true : null), { from, timeoutMs: NAV_PATIENCE_MS, signal: ctx.signal, what: `the nav bridge to listen on ${goals}` })
  } catch (error) {
    if (!(error instanceof WaitTimeout)) throw error
    throw fail(bridgeCmd, `The nav bridge did not say it listens on ${goals} within ${NAV_PATIENCE_MS / 1000} s`)
  }
  const said = afterEcho(shell.textSince(from))
  if (!listens.test(said)) {
    ctx.setNav('exited')
    throw fail(bridgeCmd, errorLine(said) ?? lastLine(said.split('\n').slice(0, -1).join('\n')) ?? 'The nav bridge ended')
  }
  ctx.navLaunched(from)
  bridgeCmd.status = 'done'
  bridgeCmd.note = `listening on ${goals}`
  ctx.setNav('running')
  step.detail = `Listening on ${goals}: the mission’s goals reach ${ctx.robot.id} through it`
  ctx.changed()
}
