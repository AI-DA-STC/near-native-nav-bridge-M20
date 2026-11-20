import type { PromptChoice, SetupPrompt, SetupStepKey, StepCommand, TerminalRole } from '../src/shared/api/setup-protocol.ts'
import {
  SSH_CHANGED_HOST_KEY,
  SSH_DENIED,
  SSH_NEW_HOST_KEY,
  SSH_PASSWORD_PROMPT,
  SSH_UNREACHABLE,
  SU_FAILED,
  SU_PASSWORD_PROMPT,
  afterEcho,
  lastLine,
} from './command-output.ts'
import { RECOVERY } from './readme-commands.ts'
import { placeOf, promptAtEnd, type ShellPrompt } from './shell-prompt.ts'
import { Aborted, type Shell } from './shell-transcript.ts'
import { StepFailed, command, fail, settle, typeChecked, type StepsContext } from './step-shell.ts'

/* Logging in to a robot from the robot terminal, as you would: `ssh <user>@<ip>`, "yes" to a new host key, the
 * password, and on an M20 `su` with the same password. A refused password or a changed host key asks the operator. */

export interface RobotLogin {
  id: string
  ip: string
  /** user on an M20, agilex on the ALOHA */
  user: string
}

export interface LoginContext extends StepsContext {
  robot: RobotLogin
  /** The robot's password as saved now: an answer to a password prompt replaces it */
  password(): string
  /** This workstation's hostname, as its prompts show it */
  laptopHost: string
  /** Shows the prompt on the step and waits for the operator's choice */
  ask(key: SetupStepKey, prompt: SetupPrompt): Promise<PromptChoice>
  setActivity(role: TerminalRole, activity: string): void
}

/** ssh refused the robot's host key: it changed since this workstation last connected */
class HostKeyChanged extends Error {}

/** ssh or su refused the password */
class PasswordRefused extends Error {}

function refused(ctx: LoginContext, cmd: StepCommand, message: string): PasswordRefused {
  cmd.status = 'failed'
  cmd.note = message
  ctx.changed()
  return new PasswordRefused(message)
}

/** Logs in with `sshCmd` (and `suCmd`, on an M20). Asks the operator when the host key changed or the password is
 * refused, and tries again with what they chose. */
export async function logIn(ctx: LoginContext, key: SetupStepKey, shell: Shell, sshCmd: StepCommand, suCmd: StepCommand | null): Promise<void> {
  const login = `${ctx.robot.user}@${ctx.robot.ip}`
  for (;;) {
    try {
      await ssh(ctx, shell, sshCmd)
      break
    } catch (error) {
      if (error instanceof HostKeyChanged) {
        const choice = await ctx.ask(key, { kind: 'host-key', ip: ctx.robot.ip })
        if (choice !== 'remove-host-key') throw new Aborted()
        const fix = command(RECOVERY.removeHostKey(ctx.robot.ip), 'laptop')
        ctx.step(key).commands.splice(ctx.step(key).commands.indexOf(sshCmd), 0, fix)
        await typeChecked(ctx, shell, fix, 15_000)
      } else if (error instanceof PasswordRefused) {
        const choice = await ctx.ask(key, { kind: 'password', login, error: error.message })
        if (choice !== 'retry-login') throw new Aborted()
      } else throw error
    }
  }
  if (!suCmd) return
  for (;;) {
    try {
      await su(ctx, shell, suCmd)
      return
    } catch (error) {
      if (!(error instanceof PasswordRefused)) throw error
      const choice = await ctx.ask(key, { kind: 'password', login: `root@${ctx.robot.ip}`, error: error.message })
      if (choice !== 'retry-login') throw new Aborted()
    }
  }
}

type SshEvent = 'new-key' | 'password' | { prompt: ShellPrompt; text: string }

async function ssh(ctx: LoginContext, shell: Shell, cmd: StepCommand): Promise<void> {
  const login = `${ctx.robot.user}@${ctx.robot.ip}`
  cmd.status = 'running'
  cmd.note = null
  ctx.setActivity('robot', cmd.text)
  ctx.changed()
  const typedAt = shell.mark()
  let from = typedAt
  let first = true
  let passwords = 0
  shell.write(`${cmd.text}\r`)
  for (;;) {
    const skipEcho = first
    const { value, end } = await shell.waitFor<SshEvent>(
      (t) => {
        const text = skipEcho ? afterEcho(t) : t
        if (SSH_NEW_HOST_KEY.test(text)) return 'new-key'
        if (SSH_PASSWORD_PROMPT.test(text)) return 'password'
        const prompt = promptAtEnd(text)
        return prompt ? { prompt, text } : null
      },
      { from, timeoutMs: 45_000, signal: ctx.signal, what: `an answer from ${ctx.robot.ip} over ssh` },
    )
    first = false
    from = end
    if (value === 'new-key') {
      // First connection from this workstation: accept the key, as you would answer "yes"
      shell.write('yes\r')
    } else if (value === 'password') {
      if (passwords++ > 0) {
        // Asked again: the password was refused. Stop ssh rather than guess.
        shell.write('\x03')
        await settle(shell, ctx.signal)
        throw refused(ctx, cmd, `The robot refused the password for ${login}`)
      }
      shell.write(`${ctx.password()}\r`)
    } else if (placeOf(value.prompt, ctx.laptopHost) === 'laptop') {
      // ssh ended without logging in
      const said = afterEcho(shell.textSince(typedAt))
      if (SSH_CHANGED_HOST_KEY.test(said)) throw new HostKeyChanged()
      if (SSH_DENIED.test(said)) throw refused(ctx, cmd, `The robot refused the password for ${login}`)
      const line = SSH_UNREACHABLE.exec(said)?.[0] ?? lastLine(said.slice(0, said.lastIndexOf('\n'))) ?? 'ssh ended'
      throw fail(cmd, `ssh: ${line}`)
    } else {
      cmd.status = 'done'
      cmd.note = `${value.prompt.user}@${value.prompt.host}`
      ctx.setActivity('robot', cmd.note)
      ctx.changed()
      return
    }
  }
}

/** `su` with the robot's password: a root shell on the robot */
export async function su(ctx: LoginContext, shell: Shell, cmd: StepCommand): Promise<void> {
  cmd.status = 'running'
  cmd.note = null
  ctx.changed()
  let from = shell.mark()
  shell.write(`${cmd.text}\r`)
  const asked = await shell.waitFor<'password' | ShellPrompt>(
    (t) => (SU_PASSWORD_PROMPT.test(afterEcho(t)) ? 'password' : promptAtEnd(afterEcho(t))),
    { from, timeoutMs: 20_000, signal: ctx.signal, what: 'su to ask for the password' },
  )
  if (asked.value !== 'password') throw fail(cmd, lastLine(afterEcho(asked.text)) ?? 'su did not ask for a password')
  from = asked.end
  shell.write(`${ctx.password()}\r`)
  const { value, text } = await shell.waitFor((t) => promptAtEnd(t), {
    from,
    timeoutMs: 20_000,
    signal: ctx.signal,
    what: 'the root prompt',
  })
  if (!value.root) {
    const said = SU_FAILED.exec(text)?.[0]
    if (said) throw refused(ctx, cmd, `su refused the password (${said})`)
    throw fail(cmd, 'su did not give a root shell')
  }
  cmd.status = 'done'
  cmd.note = `${value.user}@${value.host}`
  ctx.setActivity('robot', `${value.user}@${value.host}`)
  ctx.changed()
}

/** Back to this workstation's prompt: stops what runs in the robot terminal (the relay), then exits the container,
 * root's shell and ssh, as you would */
export async function leaveRobot(shell: Shell, laptopHost: string, signal?: AbortSignal): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const prompt = await settle(shell, signal, 1500)
    if (placeOf(prompt, laptopHost) === 'laptop') return
    const from = shell.mark()
    shell.write('exit\r')
    await shell.waitFor((t) => promptAtEnd(afterEcho(t)), { from, timeoutMs: 15_000, signal, what: 'a prompt after exit' })
  }
  throw new StepFailed('The robot terminal did not get back to this workstation')
}
