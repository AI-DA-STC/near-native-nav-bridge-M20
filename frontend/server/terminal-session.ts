import nodePty, { type IPty } from '@lydell/node-pty'
import type { TerminalRole, TerminalSessionFacts } from '../src/shared/api/setup-protocol.ts'
import { ShellTranscript, type Shell } from './shell-transcript.ts'

/* One bash in a pseudo-terminal on this workstation, as a terminal you could have opened yourself: the setup types the
 * README's commands into it, and the browser shows it and types into it too. Its scrollback is replayed to every
 * browser that opens it. node-pty comes from the @lydell/node-pty build, which ships a Linux binary: the upstream
 * package compiles on install, and focal's g++ 9 cannot build it for Node 24. */

/** The raw output a browser gets when it opens the terminal */
const SCROLLBACK_CHARS = 512 * 1024

export interface TerminalSessionInit {
  id: string
  robot: string
  role: TerminalRole
  cwd: string
  env?: NodeJS.ProcessEnv
  cols?: number
  rows?: number
}

export class TerminalSession extends ShellTranscript implements Shell {
  readonly id: string
  readonly robot: string
  readonly role: TerminalRole
  readonly startedAt = Date.now()
  exitedAt: number | null = null
  /** What runs in it now, as the session list shows it */
  activity = 'bash'
  private scrollback = ''
  private readonly viewers = new Set<(data: string) => void>()
  private readonly pty: IPty
  private readonly onChange: () => void

  constructor(init: TerminalSessionInit, onChange: () => void) {
    super()
    this.onChange = onChange
    this.id = init.id
    this.robot = init.robot
    this.role = init.role
    this.pty = nodePty.spawn('bash', [], {
      name: 'xterm-256color',
      cols: init.cols ?? 120,
      rows: init.rows ?? 32,
      cwd: init.cwd,
      env: { ...(init.env ?? process.env), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    })
    this.pty.onData((data) => {
      this.scrollback += data
      if (this.scrollback.length > SCROLLBACK_CHARS) {
        // Cut at a line start, so the replay does not begin inside an escape sequence
        const cut = this.scrollback.indexOf('\n', this.scrollback.length - (SCROLLBACK_CHARS * 3) / 4)
        this.scrollback = this.scrollback.slice(cut === -1 ? this.scrollback.length - SCROLLBACK_CHARS : cut + 1)
      }
      for (const viewer of this.viewers) viewer(data)
      this.append(data)
    })
    this.pty.onExit(({ exitCode, signal }) => {
      this.exitedAt = Date.now()
      this.activity = signal ? `ended by signal ${signal}` : `exited with code ${exitCode}`
      this.finish()
      this.onChange()
    })
  }

  write(data: string): void {
    if (!this.exited) this.pty.write(data)
  }

  /** Ctrl+C, as typed */
  interrupt(): void {
    this.write('\x03')
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return
    const c = Math.max(20, Math.min(500, Math.floor(cols)))
    const r = Math.max(5, Math.min(200, Math.floor(rows)))
    if (c !== this.pty.cols || r !== this.pty.rows) this.pty.resize(c, r)
  }

  setActivity(activity: string): void {
    if (activity === this.activity) return
    this.activity = activity
    this.onChange()
  }

  kill(): void {
    if (!this.exited) this.pty.kill('SIGHUP')
  }

  /** Streams the raw output to a browser, after replaying the scrollback through `replay` */
  watch(replay: (data: string) => void, live: (data: string) => void): () => void {
    replay(this.scrollback)
    this.viewers.add(live)
    return () => this.viewers.delete(live)
  }

  facts(): TerminalSessionFacts {
    return {
      id: this.id,
      robot: this.robot,
      role: this.role,
      state: this.exited ? 'exited' : 'running',
      startedAt: this.startedAt,
      exitedAt: this.exitedAt,
      activity: this.activity,
    }
  }
}
