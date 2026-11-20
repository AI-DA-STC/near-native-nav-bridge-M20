import type { PlanRecording, PoseFact, RecorderKey, RecordingFacts, RoutePhase } from '../src/shared/api/setup-protocol.ts'
import { afterEcho } from './command-output.ts'
import { readFleetOutput, type FleetRead } from './fleet-output.ts'
import { README, recordWaypoints } from './readme-commands.ts'
import { promptAtEnd } from './shell-prompt.ts'
import { Aborted, type Shell } from './shell-transcript.ts'
import { command, settle, typeChecked } from './step-shell.ts'

/* Recording one robot's waypoints for one phase, as the README's "Recording demo waypoints" does it by hand: in a
 * laptop terminal with the Step 3 exports, `ONLY="<id>" demo/record_waypoints.sh <phase>` into the session's plan
 * folder, then fleet_management.py's own keys: ENTER records the robot's pose, u undoes, c clears, w saves, Ctrl+C quits
 * without saving. */

const KEYS: Readonly<Record<RecorderKey, string>> = { record: '\r', undo: 'u\r', clear: 'c\r', save: 'w\r', cancel: '\x03' }

/** The pose shown on the preview: often enough to follow the robot, not every odometry message */
const POSE_EVERY_MS = 250

export interface RecorderDeps {
  /** The Routes terminal (opened on first use) */
  terminal(): Shell & { readonly id: string; setActivity(activity: string): void }
  /** The plan folder as the terminal types it: relative to the package root */
  folderForShell(plan: string): string
  watchOdom(robot: string, onPose: (pose: PoseFact) => void): () => void
  onChange(): void
  onSaved(plan: string, recording: PlanRecording): void
}

export class RouteRecorder {
  /** The recording going on, or the last one, with how it ended */
  facts: RecordingFacts | null = null
  private readonly deps: RecorderDeps
  private envFor: string | null = null
  private abort: AbortController | null = null
  private done: Promise<void> | null = null
  private stopPose: (() => void) | null = null

  constructor(deps: RecorderDeps) {
    this.deps = deps
  }

  get busy(): boolean {
    return this.facts?.state === 'starting' || this.facts?.state === 'recording'
  }

  async start(plan: string, phase: RoutePhase, robot: string, append: boolean): Promise<void> {
    if (this.busy) throw new Error(`Recording ${this.facts!.robot}’s ${this.facts!.phase}: save or cancel it first`)
    const shell = this.deps.terminal()
    const abort = new AbortController()
    this.abort = abort
    const text = recordWaypoints(phase, robot, this.deps.folderForShell(plan), append)
    this.facts = { phase, robot, append, command: text, state: 'starting', waypoints: [], message: null, pose: null, startedAt: Date.now(), endedAt: null }
    this.deps.onChange()
    try {
      await settle(shell, abort.signal)
      // README "Recording demo waypoints", Step 3: a terminal with the laptop Step 3 exports, once per terminal
      if (this.envFor !== shell.id) {
        const ctx = { signal: abort.signal, changed: () => undefined }
        for (const line of [README.exportDomain, README.exportProfile, README.sourceInstall]) await typeChecked(ctx, shell, command(line, 'laptop'), 30_000)
        this.envFor = shell.id
      }
    } catch (error) {
      this.end('failed', { text: error instanceof Error ? error.message : String(error), tone: 'fault' })
      throw error
    }
    shell.setActivity(`record_waypoints.sh ${phase} · ${robot}`)
    const from = shell.mark()
    shell.write(`${text}\r`)
    let lastPose = 0
    this.stopPose = this.deps.watchOdom(robot, (pose) => {
      if (!this.facts || pose.at - lastPose < POSE_EVERY_MS) return
      lastPose = pose.at
      this.facts.pose = pose
      this.deps.onChange()
    })
    this.done = shell
      .waitFor<FleetRead>(
        (t) => {
          const body = afterEcho(t)
          const read = readFleetOutput(body)
          this.follow(read)
          return promptAtEnd(body) ? read : null
        },
        { from, timeoutMs: null, signal: abort.signal, what: 'demo/record_waypoints.sh to end' },
      )
      .then(({ value }) => {
        if (value.saved) {
          this.end('saved', { text: value.saved, tone: 'info' })
          this.deps.onSaved(plan, { phase, robot, append, waypoints: value.waypoints.length, at: Date.now() })
        } else if (value.error) this.end('failed', { text: value.error, tone: 'fault' })
        else this.end('cancelled', { text: 'Quit without saving', tone: 'info' })
      })
      .catch((error: unknown) => {
        this.end(error instanceof Aborted ? 'cancelled' : 'failed', { text: error instanceof Error ? error.message : String(error), tone: 'fault' })
      })
      .finally(() => {
        shell.setActivity('bash')
        this.deps.onChange()
      })
  }

  /** The recorder's keys, sent as typed */
  key(key: RecorderKey): void {
    if (this.facts?.state !== 'recording') throw new Error('No recording takes keys now')
    this.deps.terminal().write(KEYS[key])
  }

  /** Quits a recording without saving (Ctrl+C), as you would, and waits for it */
  async cancel(): Promise<void> {
    if (!this.busy) return
    if (this.facts?.state === 'recording') this.deps.terminal().write(KEYS.cancel)
    else this.abort?.abort()
    await Promise.race([this.done, new Promise((resolve) => setTimeout(resolve, 10_000))])
    this.abort?.abort()
  }

  private follow(read: FleetRead): void {
    const facts = this.facts
    if (!facts || !this.busy) return
    if (read.ready) facts.state = 'recording'
    facts.waypoints = read.waypoints
    facts.message = read.message
    this.deps.onChange()
  }

  private end(state: RecordingFacts['state'], message: RecordingFacts['message']): void {
    this.stopPose?.()
    this.stopPose = null
    if (!this.facts) return
    this.facts = { ...this.facts, state, message, endedAt: Date.now() }
  }
}
