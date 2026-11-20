/* oxlint-disable no-control-regex -- escape sequences and the bell are control characters: matching them is this file's job */
/* Reading a terminal as text: the escape sequences go, and a bash prompt at the end says which shell the terminal is in.
 * The setup types the README's commands as written, so it cannot read exit codes: it waits for the prompt to come back
 * and reads what was printed before it. */

// CSI (colours, cursor moves), OSC (window titles) up to BEL or ST, other string controls, and two-character escapes
// (whose final character is never one that opens the longer ones: [ ] P X ^ _)
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[ -/]*[0-OQ-WYZ\\\x60-~]/g

const ESCAPE_AT_START = new RegExp(`^(?:${ESCAPES.source})`)

// An escape sequence cut off at the end of a chunk: kept until the next chunk completes it
const UNFINISHED_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*|[PX^_][^\x1b]*|[ -/]*)?$/

/** Splits raw terminal output into the part that can be read now and an unfinished escape sequence at its end */
export function splitFinished(raw: string): [finished: string, rest: string] {
  const cut = raw.lastIndexOf('\x1b')
  if (cut === -1) return [raw, '']
  const tail = raw.slice(cut)
  if (UNFINISHED_ESCAPE.test(tail) && !ESCAPE_AT_START.test(tail)) return [raw.slice(0, cut), tail]
  return [raw, '']
}

/** Terminal output as plain text: no escape sequences, no carriage returns, no bells or backspaces */
export function plainText(raw: string): string {
  return raw.replace(ESCAPES, '').replace(/[\r\x07\x08\x00]/g, '')
}

export interface ShellPrompt {
  user: string
  host: string
  /** As bash prints it: "~", "/home/user", "~/ros2_ws" */
  cwd: string
  root: boolean
}

// Ubuntu's PS1 '${debian_chroot:+($debian_chroot)}\u@\h:\w\$ ', optionally after "(venv) "; nothing may follow it. It
// starts a line, or follows the ^C the terminal echoed when a program that ends quietly (ros2 topic hz) left no newline.
const PROMPT_AT_END = /(?:^|\n|\^C)(?:\([^)\n]*\) ?)?([A-Za-z0-9_][A-Za-z0-9_.-]*)@([A-Za-z0-9_][A-Za-z0-9_.-]*):([^\n]*?)([#$]) $/

/** The bash prompt the text ends with, if it ends with one: the shell is idle and waits for a command */
export function promptAtEnd(text: string): ShellPrompt | null {
  const m = PROMPT_AT_END.exec(text.slice(-400))
  if (!m) return null
  return { user: m[1], host: m[2], cwd: m[3], root: m[4] === '#' }
}

/** Where a shell is: this workstation, the robot as its user, the robot as root, or the robot's nav_cmd_bridge container */
export type ShellPlace = 'laptop' | 'robot-user' | 'robot-root' | 'container'

/** The container's working directory is the workspace (/root/ros2_ws, shown as ~/ros2_ws). With network_mode: host it
 * has the robot's hostname, so the directory is what tells it from the robot's own root shell, which `su` leaves in
 * /home/user. */
export function placeOf(prompt: ShellPrompt, laptopHost: string): ShellPlace {
  if (prompt.host === laptopHost) return 'laptop'
  if (!prompt.root) return 'robot-user'
  return /(^|\/|~)ros2_ws(\/|$)/.test(prompt.cwd) ? 'container' : 'robot-root'
}
