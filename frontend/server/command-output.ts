/* What the README's commands print, read back. The commands are typed as written, so there are no exit codes: success
 * and failure are told apart by the words docker, ssh and ros2 print, on plain text (shell-prompt.ts plainText). */

/** The robot's ssh asks for the password: "user@192.168.123.100's password: " */
export const SSH_PASSWORD_PROMPT = /password: ?$/i
/** su asks for root's password */
export const SU_PASSWORD_PROMPT = /Password: ?$/
/** First connection to this robot from this workstation */
export const SSH_NEW_HOST_KEY = /continue connecting \(yes\/no(?:\/\[fingerprint\])?\)\? ?$/
/** The robot's key changed since this workstation last saw it (a reinstall, or another robot on the same IP) */
export const SSH_CHANGED_HOST_KEY = /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/
export const SSH_UNREACHABLE =
  /Connection refused|No route to host|Connection timed out|Could not resolve hostname|Network is unreachable|Connection closed by|Connection reset by/
export const SSH_DENIED = /Permission denied/
export const SU_FAILED = /su: Authentication failure|su: Sorry/

// Words a failing docker, bash or ros2 command prints; the lines of a working one have none of them
const ERROR_LINE =
  /^.*(?:\berror\b|\bno such\b|\bnot found\b|\bcannot\b|can't |unknown (?:shorthand )?flag|is not a docker command|no configuration file provided|is not running|permission denied|\bdenied:|\bfailed\b|\brefused\b).*$/im

/** The output after the command's echo, the first line */
export function afterEcho(text: string): string {
  const cut = text.indexOf('\n')
  return cut === -1 ? '' : text.slice(cut + 1)
}

/** The first line that reads as an error, trimmed */
export function errorLine(output: string): string | null {
  return ERROR_LINE.exec(output)?.[0].trim() ?? null
}

export function lastLine(output: string): string | null {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.at(-1) ?? null
}

export type PullOutcome =
  | { ok: true; updated: boolean; digest: string | null }
  | { ok: false; insecureRegistry: boolean; error: string }

/** `docker pull`: "Status: Image is up to date" or "Downloaded newer image"; anything else failed */
export function pullOutcome(output: string): PullOutcome {
  const digest = /Digest: (sha256:[0-9a-f]{12,64})/.exec(output)?.[1] ?? null
  if (/Status: Downloaded newer image/.test(output)) return { ok: true, updated: true, digest }
  if (/Status: Image is up to date/.test(output)) return { ok: true, updated: false, digest }
  return {
    ok: false,
    insecureRegistry: /server gave HTTP response to HTTPS client/i.test(output),
    error: errorLine(output) ?? lastLine(output) ?? 'docker pull printed nothing',
  }
}

export interface RelayLaunch {
  /** "process started with pid [n]" lines: one per relay node */
  started: number
  /** "[ERROR] [odom_relay-3]: process has died …" */
  died: string | null
  /** The launch itself failed: package missing, exception */
  fatal: string | null
}

export function relayLaunch(output: string): RelayLaunch {
  return {
    started: (output.match(/process started with pid \[\d+\]/g) ?? []).length,
    died: /^.*process has died.*$/m.exec(output)?.[0].trim() ?? null,
    fatal: /^.*(?:Package '[^']*' not found|\[ERROR\] \[launch\]:).*$/m.exec(output)?.[0].trim() ?? null,
  }
}

/** `ros2 topic list`: one topic per line */
export function topicsListed(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\/[A-Za-z0-9_/]+$/.test(line))
}

/** `ros2 topic hz`: every "average rate: 9.998" so far, in Hz */
export function hzRates(output: string): number[] {
  return [...output.matchAll(/average rate: ([\d.]+)/g)].map((m) => Number(m[1]))
}

/** `ros2 topic info`: "Publisher count: 1"; an unknown topic has none */
export function publisherCount(output: string): number | null {
  const m = /Publisher count: (\d+)/.exec(output)
  if (m) return Number(m[1])
  return /Unknown topic/.test(output) ? 0 : null
}

/** One message of `ros2 topic echo` on a geometry_msgs/PoseWithCovarianceStamped topic: metres, and the heading in
 * degrees (counter-clockwise from +x) */
export function echoedPose(message: string): { x: number; y: number; yaw: number } | null {
  const pos = /position:\s*\n\s*x: (\S+)\s*\n\s*y: (\S+)/.exec(message)
  const rot = /orientation:\s*\n\s*x: (\S+)\s*\n\s*y: (\S+)\s*\n\s*z: (\S+)\s*\n\s*w: (\S+)/.exec(message)
  if (!pos || !rot) return null
  const [x, y] = [Number(pos[1]), Number(pos[2])]
  const [qx, qy, qz, qw] = rot.slice(1).map(Number)
  if (![x, y, qx, qy, qz, qw].every(Number.isFinite)) return null
  const yaw = (Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz)) * 180) / Math.PI
  return { x, y, yaw }
}

/** Splits `ros2 topic echo` output into its complete messages (each ends with a "---" line) and the rest */
export function echoedMessages(output: string): { messages: string[]; rest: string } {
  const parts = output.split(/^---$\n?/m)
  const rest = parts.pop() ?? ''
  return { messages: parts, rest }
}
