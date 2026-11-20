import { hostname } from 'node:os'
import { describe, expect, it } from 'vitest'
import { afterEcho } from './command-output.ts'
import { placeOf, promptAtEnd } from './shell-prompt.ts'
import { TerminalSession } from './terminal-session.ts'

/* A real bash in a pseudo-terminal on this workstation, as the setup opens them */

describe('a terminal session', () => {
  it('types a command into bash and reads it back up to the prompt; a browser gets the scrollback', async () => {
    const session = new TerminalSession({ id: 'test', robot: 'test', role: 'laptop', cwd: process.cwd() }, () => undefined)
    try {
      const first = await session.waitFor(promptAtEnd, { from: 0, timeoutMs: 20_000, what: 'the first prompt' })
      expect(placeOf(first.value, hostname())).toBe('laptop')
      const from = session.mark()
      session.write('echo "pty $((40 + 2))"\r')
      const { text } = await session.waitFor((t) => promptAtEnd(afterEcho(t)), { from, timeoutMs: 10_000, what: 'the prompt' })
      expect(afterEcho(text)).toMatch(/^pty 42\n/)
      let replayed = ''
      const stop = session.watch(
        (scrollback) => (replayed = scrollback),
        () => undefined,
      )
      stop()
      expect(replayed).toContain('pty 42')
      expect(session.facts()).toMatchObject({ id: 'test', role: 'laptop', state: 'running' })
    } finally {
      session.kill()
    }
  }, 30_000)
})
