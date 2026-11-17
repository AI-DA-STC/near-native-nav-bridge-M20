import type { RobotKey } from '@/shared/config'
import { formatNumber, formatPercent } from '@/shared/lib'
import type { FrameBox, LogTag, Pt, RouteFacts } from '../mission-stream'
import aContentsPhoto from './images/aloha-contents.svg'
import aCameraFar from './images/r3-camera-far.svg'
import aCameraNear from './images/r3-camera-near.svg'
import { BOX, SITE } from './site-map'

/* One run of the mission as the replay plays it: when each thing happens, in seconds from Start, and where each robot
 * is at any second. The numbers are the brief's: BOX FOUND 1:47 into the sweep, 7:42 in total. */

export const T = {
  /** Patrol 1:28, until the operator sends the instruction */
  instruction: 88,
  /** The planner takes about 5 s */
  planReady: 94,
  inSlots: 127,
  /** Plan approval 0:37 */
  approved: 131,
  found: 238,
  refined: 246,
  /** Sweep 2:00 */
  swept: 251,
  /** Cordon 0:40 */
  cordoned: 291,
  atBox: 345,
  /** Three docking corrections, 10 s each */
  docked: 375,
  /** Arm pose 3 opens the lid, held 5 s for the photo */
  lidOpen: 390,
  photo: 395,
  /** ALOHA inspection 2:05 */
  armsDone: 416,
  verdict: 422,
  /** Return to formation 0:40: 7:42 in total */
  back: 462,
  /** The ALOHA gives up docking 90 s into the inspection */
  notDocked: 381,
} as const

export type DogKey = Exclude<RobotKey, 'aloha'>
export const DOGS: readonly DogKey[] = ['r1', 'r2', 'r3']

const LAP_S = 32
/** m/s between sweep waypoints; each dog pauses at a waypoint to scan before driving to the next */
const CRUISE: Record<DogKey, number> = { r1: 0.48, r2: 0.52, r3: 0.41 }
const IN_SLOT_AT: Record<DogKey, number> = { r1: 118, r2: 122, r3: T.inSlots }
const SWEEP_AT: Record<DogKey, readonly [number, number, number]> = {
  r1: [150, 205, 248],
  r2: [160, 215, T.swept],
  r3: [145, 200, 249],
}
const CORDON_AT: Record<DogKey, number> = { r1: 285, r2: T.cordoned, r3: 270 }
const RETURN_AT: Record<DogKey, number> = { r1: 455, r2: 458, r3: T.back }
const DOCK_STEP_S = 10
const ARM_POSE_AT = [375, 383, T.lidOpen, 400, 408] as const

/** Times in this module are seconds from Start; the scenarios turn them into the backend's epoch milliseconds */
export type RouteAt = Omit<RouteFacts, 'last'> & { last: { wp: number; outcome: 'succeeded'; at: number } | null }

export interface Motion {
  p: Pt
  /** Degrees, map frame: 0 = +x, counter-clockwise */
  yaw: number
  speed: number
  route: RouteAt | null
}

const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1])
const headingOf = (a: Pt, b: Pt) => (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI
const lerp = (a: Pt, b: Pt, f: number): Pt => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]
const xy = (p: Pt) => ({ x: p[0], y: p[1] })
const BOX_AT: Pt = [BOX.x, BOX.y]

function slotOf(dog: DogKey): { p: Pt; yaw: number } {
  const slot = SITE.routes.slots.find((s) => s.robot === dog)!
  return { p: [slot.x, slot.y], yaw: slot.yaw }
}

function cordonOf(dog: DogKey): Pt {
  if (dog === 'r3') return [SITE.routes.watch.x, SITE.routes.watch.y]
  const point = SITE.routes.cordon.find((c) => c.robot === dog)!
  return [point.x, point.y]
}

function sweepOf(dog: DogKey): Pt[] {
  return SITE.routes.sweep[dog]!
}

/** A leg of a route: the robot waits at `from` until it departs, then drives straight to `to` */
interface Leg {
  kind: RouteFacts['kind']
  wp: number
  total: number
  from: Pt
  to: Pt
  depart: number
  arrive: number
  /** Which way it faces once there */
  restYaw?: number
}

/** Where a robot is along its legs at second s */
function alongLegs(legs: Leg[], s: number): Motion {
  let last: RouteAt['last'] = null
  for (const leg of legs) {
    if (s >= leg.arrive) {
      last = { wp: leg.wp, outcome: 'succeeded', at: leg.arrive }
      continue
    }
    const length = dist(leg.from, leg.to)
    const route = (f: number): RouteAt => ({
      kind: leg.kind,
      total: leg.total,
      reached: leg.wp - 1,
      target: leg.wp,
      lap: null,
      state: 'driving',
      goal: xy(leg.to),
      distanceRemaining: length * (1 - f),
      legLength: length,
      last,
    })
    if (s < leg.depart) return { p: leg.from, yaw: headingOf(leg.from, leg.to), speed: 0, route: route(0) }
    const f = (s - leg.depart) / (leg.arrive - leg.depart)
    return { p: lerp(leg.from, leg.to, f), yaw: headingOf(leg.from, leg.to), speed: length / (leg.arrive - leg.depart), route: route(f) }
  }
  const end = legs[legs.length - 1]
  return {
    p: end.to,
    yaw: end.restYaw ?? headingOf(end.from, end.to),
    speed: 0,
    route: {
      kind: end.kind,
      total: end.total,
      reached: end.total,
      target: null,
      lap: null,
      state: 'finished',
      goal: null,
      distanceRemaining: null,
      legLength: null,
      last,
    },
  }
}

/** Around the dog's own patrol loop, one lap every LAP_S seconds, from its first corner at Start */
function patrolAt(dog: DogKey, s: number): Motion {
  const loop = SITE.routes.patrol[dog]!
  const n = loop.length
  const segment = loop.map((p, i) => dist(p, loop[(i + 1) % n]))
  const perimeter = segment.reduce((a, b) => a + b, 0)
  const lap = Math.floor(s / LAP_S) + 1
  let d = ((s % LAP_S) / LAP_S) * perimeter
  let i = 0
  while (i < n - 1 && d > segment[i]) {
    d -= segment[i]
    i++
  }
  const a = loop[i]
  const b = loop[(i + 1) % n]
  const lapStart = (lap - 1) * LAP_S
  const cornerAt = (k: number) => lapStart + (segment.slice(0, k).reduce((x, y) => x + y, 0) / perimeter) * LAP_S
  const last: RouteAt['last'] = i > 0 ? { wp: i, outcome: 'succeeded', at: cornerAt(i) } : lap > 1 ? { wp: n, outcome: 'succeeded', at: lapStart } : null
  return {
    p: lerp(a, b, segment[i] ? Math.min(1, d / segment[i]) : 0),
    yaw: headingOf(a, b),
    speed: perimeter / LAP_S,
    route: {
      kind: 'patrol',
      total: n,
      reached: i,
      target: i + 1,
      lap,
      state: 'driving',
      goal: xy(b),
      distanceRemaining: segment[i] - d,
      legLength: segment[i],
      last,
    },
  }
}

function sweepLegs(dog: DogKey): Leg[] {
  const points = sweepOf(dog)
  let from = slotOf(dog).p
  let ready: number = T.approved
  return points.map((to, k) => {
    const arrive = SWEEP_AT[dog][k]
    const leg = { kind: 'sweep' as const, wp: k + 1, total: points.length, from, to, arrive, depart: Math.max(ready, arrive - dist(from, to) / CRUISE[dog]) }
    from = to
    ready = arrive
    return leg
  })
}

export interface RunEnding {
  /** CLEAR sends the dogs back to their slots; ANOMALY ends the mission at the verdict */
  verdict: 'clear' | 'anomaly'
}

/** Where a dog is at second s of the run, and what it is driving to. Before Start it stands at its first patrol corner. */
export function dogAt(dog: DogKey, s: number, ending: RunEnding = { verdict: 'clear' }): Motion {
  const loop = SITE.routes.patrol[dog]!
  if (s < 0) return { p: loop[0], yaw: headingOf(loop[0], loop[1]), speed: 0, route: null }
  if (s < T.instruction) return patrolAt(dog, s)
  const slot = slotOf(dog)
  if (s < T.approved) {
    const from = patrolAt(dog, T.instruction).p
    return alongLegs([{ kind: 'formation', wp: 1, total: 1, from, to: slot.p, depart: T.instruction, arrive: IN_SLOT_AT[dog], restYaw: slot.yaw }], s)
  }
  if (s < T.swept) return alongLegs(sweepLegs(dog), s)
  const lastSweep = sweepOf(dog)[sweepOf(dog).length - 1]
  const cordon = cordonOf(dog)
  const cordonLeg: Leg = { kind: 'cordon', wp: 1, total: 1, from: lastSweep, to: cordon, depart: T.swept, arrive: CORDON_AT[dog], restYaw: headingOf(cordon, BOX_AT) }
  if (s < T.verdict || ending.verdict === 'anomaly') return alongLegs([cordonLeg], s)
  return alongLegs([{ kind: 'return', wp: 1, total: 1, from: cordon, to: slot.p, depart: T.verdict, arrive: RETURN_AT[dog], restYaw: slot.yaw }], s)
}

/** The last positions, oldest first: one every two seconds over the last ten */
export function trailOf(position: (s: number) => Pt, s: number): Pt[] {
  const points: Pt[] = []
  for (let back = 10; back >= 0; back -= 2) {
    const p = position(s - back)
    const prev = points[points.length - 1]
    if (!prev || dist(prev, p) > 0.02) points.push(p)
  }
  return points
}

export interface AlohaMotion extends Motion {
  docking: { attempt: number; state: 'idle' | 'active' | 'docked' | 'failed' }
  arms: { pose: number; state: 'idle' | 'moving' | 'holding' | 'done' }
  holdEndsAt: number | null
}

/** The ALOHA's correction poses while it docks, ending on the dock pose */
const DOCKING: ReadonlyArray<{ p: Pt; yaw: number }> = [
  { p: [4.02, -0.36], yaw: -86 },
  { p: [4.05, -0.46], yaw: -91 },
  { p: [4.07, -0.5], yaw: -94 },
]
/** Where it stays when docking fails: 3 of 3 corrections, still 0.42 m off */
const NOT_DOCKED = { p: [4.31, -0.12] as Pt, yaw: -70 }

/** Where the ALOHA is at second s, with its docking and arms; `dockingFails` is the brief's state 15 */
export function alohaAt(s: number, dockingFails = false): AlohaMotion {
  const { start, path, dock } = SITE.routes.aloha
  const idle = { docking: { attempt: 0, state: 'idle' as const }, arms: { pose: 0, state: 'idle' as const }, holdEndsAt: null }
  const dockPoint: Pt = [dock.x, dock.y]
  const toDock = (p: Pt, legLength: number): RouteAt => ({
    kind: 'aloha',
    total: 1,
    reached: 0,
    target: 1,
    lap: null,
    state: 'driving',
    goal: xy(dockPoint),
    distanceRemaining: dist(p, dockPoint),
    legLength,
    last: null,
  })
  if (s < T.cordoned) return { p: start, yaw: 75, speed: 0, route: null, ...idle }
  if (s < T.atBox) {
    // along the path at constant speed
    const segment = path.slice(1).map((p, i) => dist(path[i], p))
    const length = segment.reduce((a, b) => a + b, 0)
    let d = ((s - T.cordoned) / (T.atBox - T.cordoned)) * length
    let i = 0
    while (i < segment.length - 1 && d > segment[i]) {
      d -= segment[i]
      i++
    }
    const p = lerp(path[i], path[i + 1], Math.min(1, d / segment[i]))
    return { p, yaw: headingOf(path[i], path[i + 1]), speed: length / (T.atBox - T.cordoned), route: toDock(p, length), ...idle }
  }
  const attempts = Math.min(DOCKING.length, Math.floor((s - T.atBox) / DOCK_STEP_S) + 1)
  if (dockingFails) {
    const step = s < T.docked ? DOCKING[attempts - 1] : NOT_DOCKED
    return {
      p: step.p,
      yaw: step.yaw,
      speed: s < T.docked ? 0.08 : 0,
      route: { ...toDock(step.p, 1), state: s >= T.notDocked ? 'failed' : 'driving' },
      docking: { attempt: attempts, state: s >= T.notDocked ? 'failed' : 'active' },
      arms: { pose: 0, state: 'idle' },
      holdEndsAt: null,
    }
  }
  if (s < T.docked) {
    const step = DOCKING[attempts - 1]
    return { p: step.p, yaw: step.yaw, speed: 0.08, route: toDock(step.p, 1), docking: { attempt: attempts, state: 'active' }, arms: { pose: 0, state: 'idle' }, holdEndsAt: null }
  }
  const pose = ARM_POSE_AT.filter((at) => s >= at).length
  const holding = s >= T.lidOpen && s < T.photo
  return {
    p: dockPoint,
    yaw: dock.yaw,
    speed: 0,
    route: { kind: 'aloha', total: 1, reached: 1, target: null, lap: null, state: 'finished', goal: null, distanceRemaining: null, legLength: null, last: { wp: 1, outcome: 'succeeded', at: T.docked } },
    docking: { attempt: DOCKING.length, state: 'docked' },
    arms: { pose, state: s >= T.armsDone ? 'done' : holding ? 'holding' : 'moving' },
    holdEndsAt: holding ? T.photo : null,
  }
}

/* What R3's camera and the detector report, as the design system's placeholder frames */

export const FRAMES = { far: aCameraFar, near: aCameraNear, contents: aContentsPhoto }

const BOX_FAR: FrameBox = { x: 0.513, y: 0.55, w: 0.18, h: 0.18 }
const BOX_NEAR: FrameBox = { x: 0.432, y: 0.495, w: 0.335, h: 0.345 }

export const FOUND = { x: 4.12, y: -1.58, distM: 2.9, confidence: 0.81, uncertaintyM: 0.9, frame: aCameraFar, box: BOX_FAR, path: 'demo/detections/box_20261013_104207_3.jpg' }
export const REFINED = { x: 4.05, y: -1.7, distM: 1.6, confidence: 0.91, uncertaintyM: 0.35, frame: aCameraNear, box: BOX_NEAR, path: 'demo/detections/box_20261013_104215_4.jpg' }

export const CONTENTS = {
  photo: aContentsPhoto,
  path: 'demo/detections/contents_20261013_104655.jpg',
  objects: [
    { label: 'screwdriver', confidence: 0.56, box: { x: 0.16, y: 0.3, w: 0.43, h: 0.16 } },
    { label: 'pliers', confidence: 0.48, box: { x: 0.515, y: 0.5, w: 0.305, h: 0.25 } },
    { label: 'object', confidence: 0.39, box: { x: 0.235, y: 0.57, w: 0.18, h: 0.235 } },
  ],
}

export const PLAN_SR2 = {
  title: 'Search zones 1–3',
  summary: 'about 5 min',
  steps: [
    { robot: 'r1' as const, items: ['Sweep zone 1', 'Cordon zone 3', 'Return to slot 1', 'Patrol'] },
    { robot: 'r2' as const, items: ['Sweep zone 2', 'Cordon zone 3', 'Return to slot 2', 'Patrol'] },
    { robot: 'r3' as const, items: ['Sweep zone 3', 'Report suspicious item', 'Watch suspicious item', 'Return to slot 3', 'Patrol'] },
    { robot: 'aloha' as const, items: ['Standby', 'Drive to box', 'Open lid', 'Scan contents', 'Dock'] },
  ],
}

/* The mission's history and the script's output in a run, at their seconds from Start */

export interface TimedEvent {
  s: number
  tag: LogTag
  text: string
}
export interface TimedLine {
  s: number
  line: string
}

const ROBOT_TAG: Record<DogKey, LogTag> = { r1: 'R1', r2: 'R2', r3: 'R3' }
const ID: Record<DogKey, string> = { r1: '741', r2: '665', r3: '738' }
/** Where the navigation stack reports a dog stopped: a few centimetres off the waypoint */
const actual = (p: Pt): Pt => [p[0] - 0.018, p[1] - 0.011]

export function sweepEvents(): TimedEvent[] {
  return DOGS.flatMap((dog) =>
    sweepOf(dog).map((wp, k) => {
      const [x, y] = actual(wp)
      return { s: SWEEP_AT[dog][k], tag: ROBOT_TAG[dog], text: `WP ${k + 1}/3 reached · x ${formatNumber(x)} y ${formatNumber(y)}` }
    }),
  )
}

export function sweepOutput(): TimedLine[] {
  return DOGS.flatMap((dog) => {
    const legs = sweepLegs(dog)
    return legs.flatMap((leg, k) => {
      const [x, y] = actual(leg.to)
      const lines: TimedLine[] = [
        { s: leg.depart, line: `[FLEET] Robot ${ID[dog]} → WP ${k + 1}/3: x=${leg.to[0].toFixed(3)} y=${leg.to[1].toFixed(3)} yaw=${headingOf(leg.from, leg.to).toFixed(1)}deg` },
        { s: leg.arrive, line: `[FLEET] Robot ${ID[dog]} WP ${k + 1}/3 SUCCEEDED — actual x=${x.toFixed(3)} y=${y.toFixed(3)}` },
      ]
      return lines
    })
  })
}

export const DETECT_FOUND_TEXT = `BOX FOUND by R3 at (${formatNumber(FOUND.x)}, ${formatNumber(FOUND.y)}) · ${formatNumber(FOUND.distM, 1)} m · ${formatPercent(FOUND.confidence)}`
export const DETECT_REFINED_TEXT = `Box refined: (${formatNumber(REFINED.x)}, ${formatNumber(REFINED.y)}) · ${formatNumber(REFINED.distM, 1)} m · ${formatPercent(REFINED.confidence)}`
export const CONTENTS_TEXT = `Contents photo: ${CONTENTS.objects.map((o) => `${o.label} ${formatPercent(o.confidence)}`).join(', ')}`
