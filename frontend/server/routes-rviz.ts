import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RvizState, RvizWhich } from '../src/shared/api/setup-protocol.ts'
import { afterEcho, lastLine } from './command-output.ts'
import { README, routesRvizCommand } from './readme-commands.ts'
import { promptAtEnd } from './shell-prompt.ts'
import type { Shell } from './shell-transcript.ts'
import { command, settle, typeChecked } from './step-shell.ts'

/* The RViz a route recording draws in, as the README's "Recording demo waypoints" Step 2 has it: the map, the robots, and
 * fleet_management.py's /fleet_goal_markers, each robot in its colour, with the 2D Goal Pose tool on /fleet_goal. One
 * window for the dogs (ROS_DOMAIN_ID=0, their shared map) and one for the ALOHA (1, its own map), each in its own laptop
 * terminal. Their configs are written fresh from routes.rviz and routes_aloha.rviz into server/rviz/ (not in git). */

const SERVER_DIR = dirname(fileURLToPath(import.meta.url))
/** The package root, where the terminals type the README's commands */
const PACKAGE_ROOT = resolve(SERVER_DIR, '..', '..')
const FILE: Readonly<Record<RvizWhich, string>> = { dogs: 'routes.rviz', aloha: 'routes_aloha.rviz' }
const BEGIN = '      # ROBOT_DISPLAY_BEGIN\n'
const END = '      # ROBOT_DISPLAY_END\n'

/** RViz holds its terminal while its window is open: a prompt back within this long means it did not open */
const OPENS_WITHIN_MS = 3000

/** The config, as typed in the terminal: relative to the package root */
export function routesRvizPath(which: RvizWhich): string {
  return relative(PACKAGE_ROOT, join(SERVER_DIR, 'rviz', FILE[which]))
}

/** The config for these dogs (in the lobby's order): the first one's map (they all run the same map), and each one's
 * odometry. The ALOHA's takes none. */
export function routesRviz(which: RvizWhich, dogs: readonly string[]): string {
  // The template's own notes give way to where it comes from
  const text = readFileSync(join(SERVER_DIR, FILE[which]), 'utf8').replace(/^(#.*\n)+/, `# Written by the Command Center from frontend/server/${FILE[which]}: change that one\n`)
  if (which === 'aloha') return text
  const i = text.indexOf(BEGIN)
  const j = text.indexOf(END)
  const block = text.slice(i + BEGIN.length, j)
  const robots = dogs.map((id) => block.replaceAll('ROBOT_ID', id)).join('')
  return `${text.slice(0, i)}${robots}${text.slice(j + END.length)}`.replaceAll('MAP_ROBOT_ID', dogs[0] ?? '')
}

/** Writes the config where routesRvizPath() says; returns that path */
export function writeRoutesRviz(which: RvizWhich, dogs: readonly string[]): string {
  const path = routesRvizPath(which)
  const file = join(PACKAGE_ROOT, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, routesRviz(which, dogs))
  return path
}

type RvizShell = Shell & { readonly id: string; setActivity(activity: string): void }

export interface RvizWindowDeps {
  which: RvizWhich
  /** Its terminal, opened on first use */
  terminal(): RvizShell
  /** Its terminal if it has one, without opening one */
  existing(): RvizShell | null
  /** Writes the config; returns its path as typed */
  writeConfig(): string
  onChange(): void
}

/** One RViz window: typed into its terminal after the README's laptop exports, open until its window is closed */
export class RvizWindow {
  state: RvizState = 'closed'
  private readonly deps: RvizWindowDeps
  private envFor: string | null = null
  private opening: Promise<void> | null = null
  private watch: AbortController | null = null

  constructor(deps: RvizWindowDeps) {
    this.deps = deps
  }

  /** Opens it unless it is open; fails with what rviz2 printed when it does not stay open */
  open(): Promise<void> {
    if (this.state === 'open') return Promise.resolve()
    this.opening ??= this.launch().finally(() => {
      this.opening = null
    })
    return this.opening
  }

  private async launch(): Promise<void> {
    const shell = this.deps.terminal()
    this.watch?.abort()
    const abort = new AbortController()
    this.watch = abort
    this.set('opening')
    try {
      await settle(shell, abort.signal)
      // README laptop side, Step 3: once per terminal
      if (this.envFor !== shell.id) {
        const ctx = { signal: abort.signal, changed: () => undefined }
        for (const line of [README.exportDomain, README.exportProfile, README.sourceInstall]) await typeChecked(ctx, shell, command(line, 'laptop'), 30_000)
        this.envFor = shell.id
      }
      const text = routesRvizCommand(this.deps.which, this.deps.writeConfig())
      const from = shell.mark()
      shell.write(`${text}\r`)
      shell.setActivity(`rviz2 · ${FILE[this.deps.which]}`)
      const closed = shell.waitFor((t) => (promptAtEnd(afterEcho(t)) ? true : null), { from, timeoutMs: null, signal: abort.signal, what: 'RViz to close' })
      const early = await Promise.race([closed.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), OPENS_WITHIN_MS))])
      if (early) {
        const said = lastLine(afterEcho(shell.textSince(from)).split('\n').slice(0, -1).join('\n'))
        throw new Error(`RViz did not open${said ? `: ${said}` : ''}`)
      }
      this.set('open')
      closed.then(
        () => {
          if (this.watch === abort) this.set('closed')
          shell.setActivity('bash')
        },
        () => undefined,
      )
    } catch (error) {
      if (this.watch === abort) this.set('closed')
      shell.setActivity('bash')
      throw error
    }
  }

  /** Closes the window (Ctrl+C in its terminal, as you would) and waits for the prompt */
  async close(): Promise<void> {
    const shell = this.deps.existing()
    if (this.state === 'closed' || !shell || shell.exited) {
      this.set('closed')
      return
    }
    await this.opening?.catch(() => undefined)
    if (this.state === 'open') {
      const from = shell.mark()
      shell.write('\x03')
      await shell.waitFor((t) => (promptAtEnd(t) ? true : null), { from, timeoutMs: 8000, what: 'RViz to close' }).catch(() => undefined)
    }
    this.watch?.abort()
    this.watch = null
    this.set('closed')
  }

  private set(state: RvizState): void {
    if (state === this.state) return
    this.state = state
    this.deps.onChange()
  }
}
