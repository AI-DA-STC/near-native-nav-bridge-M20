import { useSyncExternalStore } from 'react'
import type { RobotKey } from '../config/fleet.ts'

/* The contract between the mission backend and the browser. The backend turns the mission script's output and the
 * robots' topics into snapshots; the browser only displays them and sends the operator's commands. These are transport
 * facts with timestamps, never component props: what a fact means on screen is decided in the page's model. */

/** Milliseconds since the Unix epoch, on the backend's clock */
export type Ms = number

/** A point in the map frame, metres: [x, y] */
export type Pt = [number, number]

/** A box on a camera frame, as fractions of the image (0–1) */
export interface FrameBox {
  x: number
  y: number
  w: number
  h: number
}

export type PhaseId = 'ready' | 'patrol' | 'formation' | 'approval' | 'sweep' | 'cordon' | 'inspect' | 'verdict' | 'return'
export type PhaseStatus = 'pending' | 'active' | 'done' | 'failed' | 'stopped' | 'skipped'
export type PlanStatusKey =
  | 'generating'
  | 'awaiting'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'denied'
  | 'stopped'
  | 'failed'
  | 'undecided'
export type LogTag = 'OPERATOR' | 'PLAN' | 'FLEET' | 'R1' | 'R2' | 'R3' | 'ALOHA' | 'DETECT' | 'INSPECT' | 'WARN' | 'FAULT' | 'ESTOP'

/** Something wrong, naming the robot and the likely fix */
export interface Notice {
  id: string
  tone: 'warn' | 'fault'
  robot: RobotKey | null
  /** What is wrong, naming the robot by its ID as the scripts do: "Robot 665 not connected" */
  text: string
  /** The likely fix, as a question: "is its bridge running?" */
  fix: string | null
  since: Ms
}

/** Where a robot is in the route it was sent, as the fleet manager tracks it */
export interface RouteFacts {
  kind: 'patrol' | 'formation' | 'sweep' | 'cordon' | 'return' | 'aloha'
  /** Waypoints in the route (corners of a patrol loop) */
  total: number
  /** Waypoints reached so far (in this lap, for a patrol) */
  reached: number
  /** The waypoint being driven to, 1-based; null when none is */
  target: number | null
  /** The patrol lap under way, 1-based; null for other routes */
  lap: number | null
  state: 'driving' | 'finished' | 'stopped' | 'failed'
  /** The goal being driven to, map frame */
  goal: { x: number; y: number } | null
  /** Navigation feedback: metres left to the goal, and the leg's length when it was sent */
  distanceRemaining: number | null
  legLength: number | null
  /** The last waypoint's result: reached, timed out (after 125 s) or aborted */
  last: { wp: number; outcome: 'succeeded' | 'timeout' | 'aborted'; at: Ms } | null
}

export interface RobotFacts {
  /** The ID the scripts use ("741"), overridable on the robots' side */
  id: string
  /** Added in Setup and named in the confirmed plan; a role without a robot is not in this mission */
  inMission: boolean
  /** ROS domain: the dogs are on 0, the ALOHA on 1 */
  domain: number
  bridge: 'connected' | 'disconnected'
  /** Pose on the shared map, with when it was received */
  pose: { x: number; y: number; yawDeg: number; at: Ms } | null
  /** m/s; null when unknown */
  speed: number | null
  /** Recent positions, oldest first */
  trail: Pt[]
  route: RouteFacts | null
}

export interface AlohaFacts extends RobotFacts {
  /** Its pose is on the dogs' map: false until its own map is aligned with theirs (aloha/align_map.py) */
  sameMap: boolean
  /** move_base: not answering yet, or ready */
  nav: 'waiting' | 'ready'
  /** Docking at the box: correction n of 3, then docked, or failed with the reason */
  docking: { attempt: number; of: number; state: 'idle' | 'active' | 'docked' | 'failed'; reason: string | null }
  /** Arms at pose n of 5; the last but one is held while both wrist cameras photograph the box */
  arms: { pose: number; of: number; state: 'idle' | 'moving' | 'holding' | 'done' | 'stopped' | 'failed'; holdEndsAt: Ms | null }
}

export interface PhaseFacts {
  id: PhaseId
  status: PhaseStatus
  /** The first time the phase started and the last time it ended: a plan denied sends the mission back to patrol */
  startedAt: Ms | null
  endedAt: Ms | null
  /** The script's own words for what is going on, or why the phase failed */
  detail: string
}

export interface PlanFacts {
  /** 1-based, in the order the plans were generated */
  n: number
  /** "SR2-01" once generated */
  id: string | null
  title: string | null
  summary: string | null
  /** The instruction the plan answers, as sent */
  instruction: string
  status: PlanStatusKey
  /** Each robot's steps in order, exactly as the planner wrote them */
  steps: Array<{ robot: RobotKey; items: string[] }>
  createdAt: Ms
  decidedAt: Ms | null
}

export interface DetectionFacts {
  /** The robot whose camera found the box */
  by: RobotKey
  /** Map frame, metres */
  x: number
  y: number
  /** Metres from the robot that found it */
  distM: number
  /** 0–1 */
  confidence: number
  /** Radius of the position's uncertainty, metres: it tightens as the robot gets closer */
  uncertaintyM: number
  /** The box's footprint, metres */
  size: { w: number; h: number }
  foundAt: Ms
  refinedAt: Ms | null
  refinements: number
  snapshot: { url: string; box: FrameBox | null; path: string | null }
}

export interface ContentsFacts {
  state: 'waiting' | 'capturing' | 'ready' | 'failed'
  photo: { url: string; at: Ms; path: string | null } | null
  /** Classes of the Roboflow workflow's contents model: bottle, screwdriver, tape_roll, warning_taped_box, wire */
  objects: Array<{ label: string; confidence: number; box: FrameBox | null }>
}

export interface EStopFacts {
  firedAt: Ms
  /** Every robot, in the fleet's order: confirmed with its latency, still pending, or not confirmed with the reason */
  results: Array<{ robot: RobotKey; state: 'pending' | 'confirmed' | 'unconfirmed'; latencyMs: number | null; reason: string | null }>
}

/** A line of the mission's history, as the timeline shows it */
export interface MissionEvent {
  id: string
  at: Ms
  tag: LogTag
  text: string
}

/** The ALOHA's own map, read once through its bridge: why there is none yet, when there is none */
export interface MapReadFacts {
  /** waiting: nothing to read it from yet (its bridge not running); reading; ready; failed, with why */
  state: 'waiting' | 'reading' | 'ready' | 'failed'
  reason: string | null
  /** When it was last tried */
  at: Ms | null
}

/** A robot's camera as the Command center shows it: the latest frame, at most one a second */
export interface CameraFacts {
  /** The ROS topic it comes from */
  topic: string
  /** When the latest frame arrived; null before the first */
  at: Ms | null
}

export interface MissionSnapshot {
  /** Increases with every snapshot */
  seq: number
  /** The backend's clock when it sent the snapshot: every elapsed time on screen is measured against it */
  serverTime: Ms
  limits: {
    /** A pose older than this is stale */
    poseStaleMs: number
    /** After Stop mission, how long before Force stop is offered */
    forceStopAfterMs: number
  }
  mission: { name: string; defaultInstruction: string }
  run: {
    status: 'idle' | 'running' | 'stopping' | 'ended'
    outcome: null | 'complete' | 'anomaly' | 'failed' | 'stopped' | 'estopped'
    /** Why it failed or was stopped */
    reason: string | null
    startedAt: Ms | null
    endedAt: Ms | null
    stopRequestedAt: Ms | null
    /** What the mission waits for from the operator */
    awaiting: null | 'instruction' | 'approval' | 'verdict'
    /** What keeps the mission from starting; empty when Start is possible */
    blockers: Notice[]
  }
  phases: PhaseFacts[]
  /** The instruction last sent; usedDefault when the operator sent the field empty */
  instruction: { text: string; usedDefault: boolean; at: Ms } | null
  /** Every plan of this run, oldest first, the denied ones included */
  plans: PlanFacts[]
  robots: { r1: RobotFacts; r2: RobotFacts; r3: RobotFacts; aloha: AlohaFacts }
  detection: DetectionFacts | null
  contents: ContentsFacts
  verdict: { value: 'anomaly' | 'clear'; at: Ms } | null
  warnings: Notice[]
  estop: EStopFacts | null
  /** Oldest first */
  timeline: MissionEvent[]
  /** The mission script's raw output, line by line, as printed */
  output: string[]
  /** The cameras of the robots in the mission (ROBOT_CAMERAS: the ALOHA's wrist cameras), by key. Each frame is
   * GET /api/mission/camera/<key>.jpg. Absent from a replay */
  cameras?: Record<string, CameraFacts>
  /** The ALOHA's map for its tab. Absent from a replay */
  alohaMap?: MapReadFacts
  /** Changes when the site map does (the plan in use, the SLAM map, the robots' roles): fetch it again */
  siteVersion?: string
}

/** What the operator can ask of the mission */
export type MissionCommand =
  | { type: 'start' }
  /** Graceful, like Ctrl+C: no new waypoints, each robot finishes the one it drives to, the arms freeze */
  | { type: 'stop' }
  | { type: 'force-stop' }
  /** Immediate and global */
  | { type: 'estop' }
  /** Empty sends the default instruction */
  | { type: 'instruction'; text: string }
  | { type: 'decide-plan'; plan: number; decision: 'approve' | 'deny' }
  | { type: 'verdict'; value: 'anomaly' | 'clear' }

export interface CommandResult {
  ok: boolean
  /** Why the command was refused */
  reason: string | null
}

export type Box2 = { xMin: number; xMax: number; yMin: number; yMax: number }

/** The site: the robots' own occupancy grid and the routes recorded for each phase (demo/waypoints/*.json) */
export interface SiteMap {
  extent: Box2
  /** The SLAM grid as an image placed in map coordinates, when the backend has one */
  occupancy: { url: string; x: number; y: number; w: number; h: number } | null
  free: Pt[][]
  walls: Array<{ points: Pt[]; closed?: boolean } | { rect: [x: number, y: number, w: number, h: number] }>
  zones: Array<{ id: string; label: string; points: Pt[] }>
  /** The box the mission is about, where it is known to be (fleet_management.py's BOX_POSE): yaw in degrees */
  box: { x: number; y: number; yaw: number; w: number; h: number } | null
  routes: {
    patrol: Partial<Record<RobotKey, Pt[]>>
    /** A slot for each dog in the formation */
    slots: Array<{ n: number; robot: RobotKey; x: number; y: number; yaw: number }>
    sweep: Partial<Record<RobotKey, Pt[]>>
    cordon: Array<{ robot: RobotKey; x: number; y: number }>
    /** Where R3 watches the box from: the end of its sweep */
    watch: { robot: RobotKey; x: number; y: number } | null
    /** null while the ALOHA's map is not the dogs' */
    aloha: { start: Pt; path: Pt[]; dock: { x: number; y: number; yaw: number } } | null
  }
}

export type ConnectionStatus = 'connecting' | 'open' | 'closed'

/** Where snapshots come from: the prototype's scenario replay now, the mission backend later. A source emits at least
 * once a second while the mission runs, since every clock on screen follows serverTime. */
export interface MissionSource {
  readonly kind: 'replay' | 'live'
  status(): ConnectionStatus
  /** Calls back on every new snapshot or status change */
  subscribe(onChange: () => void): () => void
  getSnapshot(): MissionSnapshot | null
  send(command: MissionCommand): Promise<CommandResult>
  /** The dogs' map, or the ALOHA's own: the two are not aligned */
  siteMap(map?: SiteMapKind): Promise<SiteMap>
}

/** Which map: the dogs' SLAM map, or the ALOHA's */
export type SiteMapKind = 'dogs' | 'aloha'

let source: MissionSource | null = null

/** Connects the whole app to its mission source, once, before the first render */
export function connectMission(next: MissionSource): void {
  source = next
}

export function missionSource(): MissionSource {
  if (!source) throw new Error('No mission source: connectMission() runs before the app renders')
  return source
}

/** The latest snapshot, or null until the first one arrives */
export function useMissionSnapshot(): MissionSnapshot | null {
  const s = missionSource()
  return useSyncExternalStore(s.subscribe, s.getSnapshot, s.getSnapshot)
}

export function useConnectionStatus(): ConnectionStatus {
  const s = missionSource()
  return useSyncExternalStore(s.subscribe, s.status, s.status)
}
