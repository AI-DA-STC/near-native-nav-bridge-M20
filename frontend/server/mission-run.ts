import { spawn } from 'node:child_process'
import type { EStopFacts } from '../src/shared/api/mission-stream.ts'
import type { RobotKey } from '../src/shared/config/fleet.ts'
import { afterEcho } from './command-output.ts'
import type { OutputLine } from './mission-output.ts'
import { README } from './readme-commands.ts'
import { plainText } from './shell-prompt.ts'
import { Aborted, type Shell } from './shell-transcript.ts'
import { command, settle, typeChecked } from './step-shell.ts'

/* The mission, as README "Running the demo" runs it by hand: demo/run_demo.sh on the plan in use, in a laptop terminal
 * with the Step 3 exports, answered as typed (the instruction, approve or deny, anomaly or clear). Stop is Ctrl+C;
 * Force stop closes the terminal. E-STOP sends each dog `nav_cmd_bridge estop`, cancels the ALOHA's move_base, and
 * ends the run. */

/** Ends the typed line so the exit code reaches the page: run_demo.sh exits 0, 130 on Ctrl+C, else failed */
export const EXIT_MARK = '[MISSION] exit'

export interface MissionRunDeps {
  /** The Mission terminal (opened on first use) */
  terminal(): Shell & { readonly id: string; setActivity(activity: string): void; kill(): void }
  /** The script: demo/run_demo.sh, or MISSION_SCRIPT for a fake one */
  script: string
  packageRoot: string
  onChange(): void
}

export interface EStopTarget {
  robot: RobotKey
  /** A dog's IP, for `nav_cmd_bridge estop --ip`; null for the ALOHA (its move_base is cancelled) */
  ip: string | null
}

/** The command run_demo.sh is started with */
export function missionCommand(script: string, waypoints: string, r3: string | null): string {
  const env = [`WAYPOINTS=${waypoints}`, ...(r3 ? [`R3=${r3}`] : []), 'DETECT=fixed'].join(' ')
  // No echo while it runs: what the operator answers does not come back as output
  return `stty -echo; ${env} ${script}; echo "${EXIT_MARK} $?"; stty echo`
}

const LAPTOP_ENV = ['source /opt/ros/foxy/setup.bash', 'export FASTRTPS_DEFAULT_PROFILES_FILE=fastdds_profile.xml', 'source install/setup.bash'].join(' && ')

export class MissionRun {
  status: 'idle' | 'running' | 'stopping' | 'ended' = 'idle'
  startedAt: number | null = null
  endedAt: number | null = null
  stopRequestedAt: number | null = null
  lines: OutputLine[] = []
  /** The last line, not finished yet: a prompt waiting for an answer */
  pending = ''
  /** Why it could not start or ended without the script's exit code */
  error: string | null = null
  estop: EStopFacts | null = null
  estopped = false
  private readonly deps: MissionRunDeps
  /** The terminal this run types into */
  private shell: ReturnType<MissionRunDeps['terminal']> | null = null
  private envFor: string | null = null
  private abort: AbortController | null = null
  private seen = 0

  constructor(deps: MissionRunDeps) {
    this.deps = deps
  }

  get live(): boolean {
    return this.status === 'running' || this.status === 'stopping'
  }

  async start(waypoints: string, r3: string | null): Promise<void> {
    if (this.live) throw new Error('The mission is running')
    const shell = this.deps.terminal()
    this.shell = shell
    const abort = new AbortController()
    this.abort = abort
    Object.assign(this, { status: 'running', startedAt: Date.now(), endedAt: null, stopRequestedAt: null, lines: [], pending: '', error: null, estop: null, estopped: false })
    this.seen = 0
    this.deps.onChange()
    try {
      await settle(shell, abort.signal)
      if (this.envFor !== shell.id) {
        const ctx = { signal: abort.signal, changed: () => undefined }
        for (const line of [README.exportDomain, README.exportProfile, README.sourceInstall]) await typeChecked(ctx, shell, command(line, 'laptop'), 30_000)
        this.envFor = shell.id
      }
    } catch (error) {
      this.finish(error instanceof Error ? error.message : String(error))
      throw error
    }
    const text = missionCommand(this.deps.script, waypoints, r3)
    shell.setActivity(this.deps.script)
    const from = shell.mark()
    shell.write(`${text}\r`)
    shell
      .waitFor((t) => (this.follow(afterEcho(t)) ? true : null), { from, timeoutMs: null, signal: abort.signal, what: 'the mission to end' })
      .then(
        () => this.finish(null),
        (error: unknown) => this.finish(error instanceof Aborted ? null : error instanceof Error ? error.message : String(error)),
      )
  }

  /** A line typed into the script: the instruction (empty: its default), approve or deny, anomaly or clear */
  answer(line: string): void {
    if (this.status !== 'running') throw new Error('The mission is not running')
    if (['\r', '\n', '\u0003'].some((c) => line.includes(c))) throw new Error('One line only')
    this.shell?.write(`${line}\r`)
  }

  /** Ctrl+C, as by hand: no new waypoints; each robot finishes the one it drives to, the ALOHA's arms freeze */
  stop(): void {
    if (!this.live) throw new Error('The mission is not running')
    this.status = 'stopping'
    this.stopRequestedAt ??= Date.now()
    this.shell?.write('\x03')
    this.deps.onChange()
  }

  /** Closes the Mission terminal: the script and everything it started end */
  forceStop(): void {
    if (!this.live) throw new Error('The mission is not running')
    this.shell?.kill()
    this.finish('Force stopped: the Mission terminal was closed')
  }

  /** Every dog gets `nav_cmd_bridge estop` (its reply confirms it), the ALOHA's move_base is cancelled, the run ends */
  emergencyStop(targets: readonly EStopTarget[]): void {
    const firedAt = Date.now()
    this.estopped = true
    this.estop = { firedAt, results: targets.map((t) => ({ robot: t.robot, state: 'pending', latencyMs: null, reason: null })) }
    this.deps.onChange()
    for (const target of targets) {
      const script = target.ip
        ? `install/nav_cmd_bridge/lib/nav_cmd_bridge/nav_cmd_bridge estop --ip ${target.ip}`
        : `export ROS_DOMAIN_ID=1 && ros2 topic pub --once /move_base/cancel actionlib_msgs/msg/GoalID '{}'`
      this.runEStop(target.robot, script, target.ip ? /estop sent\s*\n\s*\S/ : /publishing #1/, firedAt)
    }
    if (this.live) {
      this.status = 'stopping'
      this.stopRequestedAt ??= firedAt
      this.shell?.write('\x03')
    }
  }

  private runEStop(robot: RobotKey, script: string, confirmed: RegExp, firedAt: number): void {
    const child = spawn('bash', ['-c', `${LAPTOP_ENV} && ${script}`], { cwd: this.deps.packageRoot, env: { ...process.env, PYTHONUNBUFFERED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const settleWith = (state: 'confirmed' | 'unconfirmed', reason: string | null) => {
      const result = this.estop?.results.find((r) => r.robot === robot)
      if (!result || result.state !== 'pending') return
      Object.assign(result, { state, latencyMs: state === 'confirmed' ? Date.now() - firedAt : null, reason })
      this.deps.onChange()
    }
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      if (confirmed.test(output)) settleWith('confirmed', null)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (error) => settleWith('unconfirmed', error.message))
    child.on('close', () => settleWith('unconfirmed', output.includes('estop sent') ? 'sent, no reply within 3 s' : output.trim().split('\n').at(-1) || 'did not run'))
  }

  private follow(text: string): boolean {
    const parts = text.replace(/\r/g, '').split('\n')
    const pending = parts.pop() ?? ''
    if (parts.length > this.seen) {
      const now = Date.now()
      for (const line of parts.slice(this.seen)) this.lines.push({ at: now, text: plainText(line) })
      this.seen = parts.length
      this.deps.onChange()
    }
    if (pending !== this.pending) {
      this.pending = pending
      this.deps.onChange()
    }
    return this.lines.some((l) => l.text.startsWith(EXIT_MARK))
  }

  private finish(error: string | null): void {
    if (this.status === 'ended') return
    this.abort?.abort()
    this.status = 'ended'
    this.endedAt = Date.now()
    if (error) this.error = error
    if (this.shell && !this.shell.exited) this.shell.setActivity('bash')
    this.deps.onChange()
  }

  /** Back to before the start, once it ended */
  reset(): void {
    if (this.live) return
    Object.assign(this, { status: 'idle', startedAt: null, endedAt: null, stopRequestedAt: null, lines: [], pending: '', error: null, estop: null, estopped: false })
  }

  /** Server shutdown: Ctrl+C, then close the terminal */
  async shutdown(): Promise<void> {
    if (!this.live) return
    this.shell?.write('\x03')
    await new Promise((resolve) => setTimeout(resolve, 3000))
    if (this.live) this.forceStop()
  }
}
