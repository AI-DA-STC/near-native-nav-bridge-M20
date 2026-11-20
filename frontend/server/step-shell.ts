import type { CommandPlace, SetupStepFacts, SetupStepKey, StepCommand } from '../src/shared/api/setup-protocol.ts'
import { afterEcho, errorLine } from './command-output.ts'
import { promptAtEnd, type ShellPrompt } from './shell-prompt.ts'
import { Aborted, ShellExited, WaitTimeout, type Shell } from './shell-transcript.ts'

/* What every robot's setup does the same way: typing a command once the prompt is back and reading what it printed,
 * getting an idle prompt back, and running the steps in order with their status. */

/** A step that cannot go on; the message is shown with it */
export class StepFailed extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StepFailed'
  }
}

/** What typing needs from a run */
export interface TypingContext {
  signal: AbortSignal
  /** Publishes the step facts changed in place */
  changed(): void
}

export interface StepsContext extends TypingContext {
  /** A step's facts, changed in place */
  step(key: SetupStepKey): SetupStepFacts
}

export function command(text: string, where: CommandPlace): StepCommand {
  return { text, where, status: 'pending', note: null }
}

export function fail(cmd: StepCommand, message: string): StepFailed {
  cmd.status = 'failed'
  cmd.note = message
  return new StepFailed(message)
}

export function messageOf(error: unknown): string {
  if (error instanceof ShellExited) return 'The terminal session ended'
  if (error instanceof Error) return error.message
  return String(error)
}

/** Types a command and waits for the prompt to come back; returns what it printed (without its echo and the prompt) */
export async function type(ctx: TypingContext, shell: Shell, cmd: StepCommand, timeoutMs: number) {
  cmd.status = 'running'
  ctx.changed()
  const from = shell.mark()
  shell.write(`${cmd.text}\r`)
  const { value, text } = await shell.waitFor((t) => promptAtEnd(afterEcho(t)), {
    from,
    timeoutMs,
    signal: ctx.signal,
    what: `the prompt after \`${cmd.text}\``,
  })
  const body = afterEcho(text)
  return { output: body.slice(0, body.lastIndexOf('\n') + 1), prompt: value }
}

/** Types a command whose failure stops the step: anything that reads as an error fails it */
export async function typeChecked(ctx: TypingContext, shell: Shell, cmd: StepCommand, timeoutMs: number) {
  const result = await type(ctx, shell, cmd, timeoutMs)
  const error = errorLine(result.output)
  if (error) {
    cmd.status = 'failed'
    cmd.note = error
    throw new StepFailed(error)
  }
  cmd.status = 'done'
  ctx.changed()
  return result
}

/** The shell's prompt once it is idle. A program that holds the terminal (a relay, rviz2) gets Ctrl+C, as you would. */
export async function settle(shell: Shell, signal?: AbortSignal, patienceMs = 10_000): Promise<ShellPrompt> {
  const here = promptAtEnd(shell.textSince(shell.mark() - 400))
  if (here) return here
  try {
    return (await shell.waitFor(promptAtEnd, { from: shell.mark() - 400, timeoutMs: patienceMs, signal, what: 'a prompt' })).value
  } catch (error) {
    if (!(error instanceof WaitTimeout)) throw error
  }
  const from = shell.mark()
  shell.write('\x03')
  return (await shell.waitFor(promptAtEnd, { from, timeoutMs: 20_000, signal, what: 'a prompt after Ctrl+C' })).value
}

/** Runs the steps from `from` to the end, each marked active, then done; a failure marks its step and throws, and
 * Aborted means the operator stopped */
export async function runSteps<C extends StepsContext>(
  ctx: C,
  keys: readonly SetupStepKey[],
  run: Partial<Record<SetupStepKey, (ctx: C) => Promise<void>>>,
  pending: (key: SetupStepKey) => SetupStepFacts,
  from: SetupStepKey,
): Promise<void> {
  const start = Math.max(0, keys.indexOf(from))
  for (const key of keys.slice(start)) {
    const step = ctx.step(key)
    Object.assign(step, pending(key), { status: 'active', startedAt: Date.now() })
    ctx.changed()
    try {
      const body = run[key]
      if (!body) throw new StepFailed(`No step ${key}`)
      await body(ctx)
    } catch (error) {
      const stopped = error instanceof Aborted
      for (const c of step.commands) if (c.status === 'running') c.status = stopped ? 'pending' : 'failed'
      Object.assign(step, {
        status: stopped ? 'stopped' : 'failed',
        endedAt: Date.now(),
        prompt: null,
        error: stopped ? null : messageOf(error),
        detail: stopped ? 'Stopped' : step.detail,
      })
      ctx.changed()
      throw error
    }
    Object.assign(step, { status: 'done', endedAt: Date.now(), prompt: null })
    ctx.changed()
  }
}
