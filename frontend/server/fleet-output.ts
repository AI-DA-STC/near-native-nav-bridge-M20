import type { WaypointFact } from '../src/shared/api/setup-protocol.ts'

/* What demo/record_waypoints.sh and fleet_management.py --record print, read back (plain text, one line each): the
 * waypoints recorded so far, what went wrong, and how the recording ended. */

export interface FleetMessage {
  text: string
  tone: 'info' | 'warn' | 'fault'
}

export interface FleetRead {
  /** fleet_management.py has shown its ">>> … <<<" prompt: it takes keys */
  ready: boolean
  /** The recording's waypoints, after every record, undo and clear so far */
  waypoints: WaypointFact[]
  message: FleetMessage | null
  /** "Saved 741 (3 WP) to demo/waypoints/…/sweep.json, kept robot 665, 738" */
  saved: string | null
  /** Why the recording could not run at all */
  error: string | null
}

const NUMBER = String.raw`-?\d+(?:\.\d+)?`
const WAYPOINT = new RegExp(String.raw`^\[FLEET\] Robot (\S+) WP (\d+): x=(${NUMBER}) y=(${NUMBER}) yaw=(${NUMBER})deg$`)
const DROPPED = /^\[FLEET\] Robot (\S+): dropped WP \d+, (\d+) left$/
const DEG = Math.PI / 180

const round3 = (n: number) => Math.round(n * 1000) / 1000

export function readFleetOutput(text: string): FleetRead {
  const read: FleetRead = { ready: false, waypoints: [], message: null, saved: null, error: null }
  const lines = text.split('\n').map((line) => line.trim())
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let m: RegExpExecArray | null
    if (/^>>> .* <<<$/.test(line)) read.ready = true
    else if ((m = WAYPOINT.exec(line))) {
      const n = Number(m[2])
      read.waypoints = read.waypoints.slice(0, n - 1)
      read.waypoints[n - 1] = { x: Number(m[3]), y: Number(m[4]), yaw: round3(Number(m[5]) * DEG) }
      read.message = null
    } else if ((m = DROPPED.exec(line))) {
      read.waypoints = read.waypoints.slice(0, Number(m[2]))
      read.message = { text: `Dropped its last waypoint: ${m[2]} left`, tone: 'info' }
    } else if (/^\[FLEET\] Cleared all waypoints/.test(line)) {
      read.waypoints = []
      read.message = { text: 'Cleared its waypoints', tone: 'info' }
    } else if ((m = /^\[FLEET\] Robot (\S+) has no waypoints to undo/.exec(line))) {
      read.message = { text: `${m[1]} has no waypoints to undo`, tone: 'info' }
    } else if ((m = /^\[FLEET\] Robot (\S+) already has its waypoint/.exec(line))) {
      read.message = { text: `${m[1]} already has its one waypoint here: undo it to record another`, tone: 'warn' }
    } else if ((m = /^\[FLEET\] Not recorded: (.+)$/.exec(line))) {
      read.message = { text: `Not recorded: ${m[1]}`, tone: 'fault' }
    } else if ((m = /^\[FLEET\] Not saved: (.+)$/.exec(line))) {
      read.message = { text: `Not saved: ${m[1]}`, tone: 'fault' }
    } else if ((m = /^\[FLEET\] Unknown command '(.*)'/.exec(line))) {
      read.message = { text: `fleet_management.py did not take “${m[1]}”`, tone: 'warn' }
    } else if ((m = /^\[FLEET\] (Saved .+)$/.exec(line))) {
      read.saved = m[1]
      read.message = { text: m[1], tone: 'info' }
    } else if ((m = /^=== (\w+): none of ONLY=(.*) takes part, skipped ===$/.exec(line))) {
      read.error = `${m[2]} takes no part in the ${m[1]}`
    } else if ((m = /^Unknown phase '(\w+)'/.exec(line))) {
      read.error = `record_waypoints.sh knows no phase ${m[1]}`
    } else if (/^Traceback \(most recent call last\):$/.test(line)) {
      // The exception is the traceback's last line
      const rest = lines.slice(i + 1).filter((l) => l && !/^File "|^\^+$/.test(l))
      read.error = rest.findLast((l) => /^\w+(?:\.\w+)*(?:Error|Exception)\b/.test(l)) ?? 'fleet_management.py stopped with an exception'
    } else if ((m = /^fleet_management\.py: error: (.+)$/.exec(line))) {
      read.error = m[1]
    }
  }
  return read
}
