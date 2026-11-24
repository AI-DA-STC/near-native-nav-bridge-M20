/* The setup protocol: what the setup server (frontend/server) reports about the robots it brings up, and what the page
 * sends it. Types only, with no imports, so the server can import this file too. The server owns every fact; the page
 * only displays them. */

export type Ms = number

/** 'm20': a Lynx M20 Pro dog, set up by the README's steps · 'aloha': the Mobile ALOHA, set up by its start_aloha.sh */
export type RobotKind = 'm20' | 'aloha'

/** From a TCP connect to the robot every 2 s: 'unknown' until the first answer */
export type Presence = 'online' | 'offline' | 'unknown'

/** An M20: log in, then the README's steps a–e (image … localize). The ALOHA: log in, start_aloha.sh, the stack it
 * starts, then aloha/bridge.sh on this workstation. */
export type SetupStepKey = 'login' | 'image' | 'relay' | 'laptop' | 'topics' | 'localize' | 'nav' | 'start' | 'stack' | 'bridge'

/** pending ○ · active ▶ · done ✓ · failed ✕ · stopped ■ · skipped – · decision ◆ (the operator's turn) */
export type SetupStepStatus = 'pending' | 'active' | 'done' | 'failed' | 'stopped' | 'skipped' | 'decision'

export type CommandStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

/** Where a command is typed: this workstation, the robot's shell, or the nav_cmd_bridge container on the robot */
export type CommandPlace = 'laptop' | 'robot' | 'container'

export interface StepCommand {
  /** As typed into the terminal: verbatim from README.md, or one of the recovery commands the operator chose */
  text: string
  where: CommandPlace
  status: CommandStatus
  /** The outcome in a few words: "up to date", "8 of 8 relays started" */
  note: string | null
}

export interface StepCheck {
  label: string
  /** null: not checked yet */
  ok: boolean | null
  value: string | null
}

/** A pose from rviz's 2D Pose Estimate, as it arrived on /initialpose_relayed_<id>: metres and degrees, map frame */
export interface PoseFact {
  x: number
  y: number
  yaw: number
  at: Ms
}

/** What the setup waits for the operator to decide; the step shows it, the answer is a PromptChoice */
export type SetupPrompt =
  /** The robot's Docker does not trust this workstation's plain-HTTP registry: README "On robot, trust …" */
  | { kind: 'registry'; registry: string; error: string }
  /** The pull failed for another reason: retry, or go on with the image already on the robot */
  | { kind: 'pull-failed'; error: string }
  /** Someone already publishes the robot's relayed topics: a relay left running, or started by hand */
  | { kind: 'relay-running'; topic: string; publishers: number }
  /** ssh refuses the robot's new host key */
  | { kind: 'host-key'; ip: string }
  /** rviz2 is open: set the 2D Pose Estimate, then confirm */
  | { kind: 'localize'; rviz: 'running' | 'closed'; pose: PoseFact | null; /** the ALOHA: where AMCL has it after the estimate */ amcl?: PoseFact | null }
  /** ssh or su refused the password: the operator types it again ("agilex@192.168.123.200") */
  | { kind: 'password'; login: string; error: string }
  /** start_aloha.sh found its tmux session already running on the ALOHA */
  | { kind: 'aloha-running' }

export type PromptChoice =
  | 'retry'
  | 'skip'
  | 'stop'
  | 'restart-container'
  | 'keep-relay'
  | 'remove-host-key'
  | 'open-rviz'
  | 'localized'
  /** With the password typed in the prompt: it replaces the robot's saved one */
  | 'retry-login'
  | 'restart-aloha'
  | 'keep-aloha'

export interface SetupStepFacts {
  key: SetupStepKey
  status: SetupStepStatus
  /** One line: what happened, or what it is doing now */
  detail: string
  startedAt: Ms | null
  endedAt: Ms | null
  commands: StepCommand[]
  checks: StepCheck[]
  prompt: SetupPrompt | null
  /** Why it failed, from the terminal where possible */
  error: string | null
}

/** idle: never run since the server started · waiting: a step waits for the operator */
export type SetupRunState = 'idle' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped'

/** none: not started by this server · kept: one already running was kept · exited: it stopped (Ctrl+C, crash, lost link) */
export type RelayState = 'none' | 'starting' | 'running' | 'kept' | 'exited'

export interface RobotSetupFacts {
  kind: RobotKind
  /** The robot ID, which suffixes its relayed topics ("741"); "aloha" for the ALOHA */
  id: string
  ip: string
  /** Its login: "user" on an M20, "agilex" on the ALOHA. The password stays on the setup server. */
  user: string
  addedAt: Ms
  presence: Presence
  presenceSince: Ms
  lastSeen: Ms | null
  setup: {
    state: SetupRunState
    /** Seven steps for an M20, four for the ALOHA */
    steps: SetupStepFacts[]
    startedAt: Ms | null
    endedAt: Ms | null
  }
  /** An M20's relays.launch.py on the robot; the ALOHA's aloha/bridge.sh on this workstation */
  relay: { state: RelayState; since: Ms | null; rateHz: number | null }
  /** An M20's nav bridge on this workstation (README Multi-robot Step 1), which run_demo.sh's goals go through; the
   * ALOHA has none */
  nav: { state: RelayState; since: Ms | null }
  /** When its setup last finished, kept across server restarts */
  lastReadyAt: Ms | null
  /** Its terminal sessions, when open */
  sessions: { robot: string | null; laptop: string | null; nav: string | null }
}

/** A robot from the README's table that is not added yet, with whether it answers */
export interface RobotSuggestion {
  kind: RobotKind
  id: string
  ip: string
  /** Its README login */
  user: string
  presence: Presence
}

/** robot: ssh to the robot (its relay, or start_aloha.sh's tmux) · laptop: this workstation's checks, rviz2, the
 * ALOHA's bridge · nav: an M20's nav bridge · ping: Fleet health's ping dashboard for a robot or the router (its robot is
 * then ROUTER_ID) · routes: demo/record_waypoints.sh · rviz-dogs, rviz-aloha: the RViz that recording draws in ·
 * mission: demo/run_demo.sh */
export type TerminalRole = 'robot' | 'laptop' | 'nav' | 'ping' | 'routes' | 'rviz-dogs' | 'rviz-aloha' | 'mission'

export interface TerminalSessionFacts {
  id: string
  robot: string
  /** robot: the shell that sshes into the robot and runs its relay · laptop: exports, topic checks and rviz2 */
  role: TerminalRole
  state: 'running' | 'exited'
  startedAt: Ms
  exitedAt: Ms | null
  /** What it runs now, for the session list: "ros2 launch nav_cmd_bridge relays.launch.py" */
  activity: string
}

// ---------------------------------------------------------------------------------------------------------------------
// Routes: the mission plan's waypoints, recorded with demo/record_waypoints.sh into dated folders of demo/waypoints

/** The demo's phases, in run_demo.sh's order; aloha is the ALOHA's route to the box (aloha.json) */
export type RoutePhase = 'patrol' | 'formation' | 'sweep' | 'cordon' | 'aloha'

/** As the plan's JSON keeps it: metres in the map frame, yaw in radians */
export interface WaypointFact {
  x: number
  y: number
  yaw: number
}

export interface PlanPhaseFacts {
  /** Robot ID → waypoints, for every robot in the phase's file */
  robots: Record<string, number>
  /** The file's robots in its own order (an object's integer-like keys lose it): fleet_management.py colours by it */
  order: string[]
  /** null: the phase is fine for the mission */
  problem: string | null
}

/** A recording saved in a plan's session: what it changed over the plan it started from */
export interface PlanRecording {
  phase: RoutePhase
  robot: string
  append: boolean
  waypoints: number
  at: Ms
}

/** One plan: a folder of demo/waypoints named by when its session started ("2026-11-20_15-02-10", local time) */
export interface PlanSummary {
  id: string
  /** The plan its session started from (copied, then recorded over) */
  basedOn: string | null
  recorded: PlanRecording[]
  phases: Record<RoutePhase, PlanPhaseFacts>
  /** Robots its session left out of the plan it started from: they were not added in Setup */
  leftOut: string[]
  /** manipulator.json's arm poses, or null when it is missing */
  armPoses: number | null
  /** What keeps it from being used, in words; empty: run_demo.sh can run it */
  problems: string[]
  /** demo/waypoints/current points here: the plan run_demo.sh uses */
  current: boolean
}

/** A plan's waypoints, for its preview (GET /api/plans/<id>) */
export interface PlanRoutes {
  id: string
  /** null: the phase's file is missing or unreadable */
  phases: Record<RoutePhase, Record<string, WaypointFact[]> | null>
}

/** The recorder's keys, as fleet_management.py --record reads them: ENTER, u, c, w, Ctrl+C */
export type RecorderKey = 'record' | 'undo' | 'clear' | 'save' | 'cancel'

export interface RecordingFacts {
  phase: RoutePhase
  robot: string
  append: boolean
  /** As typed into the Routes terminal */
  command: string
  /** starting: typed, not taking keys yet · recording: takes keys · then how it ended */
  state: 'starting' | 'recording' | 'saved' | 'cancelled' | 'failed'
  /** This recording's waypoints so far, as fleet_management.py printed them */
  waypoints: WaypointFact[]
  /** What fleet_management.py said last that matters: "Not recorded: no odometry yet on /ODOM_relayed_741" */
  message: { text: string; tone: 'info' | 'warn' | 'fault' } | null
  /** Where the robot is now, from /ODOM_relayed_<id> or the ALOHA's /amcl_pose (yaw in degrees) */
  pose: PoseFact | null
  startedAt: Ms
  endedAt: Ms | null
}

/** A recording session: a new plan folder, copied from `basedOn`, that recordings go into */
export interface RouteSessionFacts {
  plan: string
  basedOn: string | null
  startedAt: Ms
  recording: RecordingFacts | null
  /** The Routes terminal, once opened */
  terminal: string | null
  /** The RViz windows recording draws in: the dogs' (ROS_DOMAIN_ID=0) and the ALOHA's (1) */
  rviz: Record<RvizWhich, RvizState>
}

export type RvizWhich = 'dogs' | 'aloha'
export type RvizState = 'closed' | 'opening' | 'open'

/** The operator's way through the console: Setup, then Routes, then the Command center */
export interface FlowFacts {
  setupConfirmedAt: Ms | null
  plan: { id: string; confirmedAt: Ms } | null
  /** MISSION_UNLOCKED=1: the Command center opens without both, to look at it on demo data */
  unlocked: boolean
}

export interface SetupSnapshot {
  serverTime: Ms
  robots: RobotSetupFacts[]
  suggestions: RobotSuggestion[]
  sessions: TerminalSessionFacts[]
  flow: FlowFacts
  /** Newest first */
  plans: PlanSummary[]
  session: RouteSessionFacts | null
  /** Who takes part in each phase: the robots added in Setup, in the lobby's order */
  participants: Record<RoutePhase, string[]>
}

export type SetupCommand =
  /** password null: the README's for the kind */
  | { type: 'add-robot'; kind: RobotKind; id: string; ip: string; user: string; password: string | null }
  | { type: 'remove-robot'; robot: string }
  /** From the first step, after stopping what the last run left running */
  | { type: 'start-setup'; robot: string }
  | { type: 'stop-setup'; robot: string }
  /** From the step that failed or stopped */
  | { type: 'retry-step'; robot: string }
  /** password: with 'retry-login' */
  | { type: 'answer'; robot: string; choice: PromptChoice; password?: string }
  /** Every robot in the lobby is ready: on to Routes */
  | { type: 'confirm-setup' }
  /** Use this plan: demo/waypoints/current points at it */
  | { type: 'confirm-plan'; plan: string }
  /** A new plan folder, copied from basedOn, named in the browser's local time (its offset from UTC, in minutes) */
  | { type: 'new-session'; basedOn: string | null; utcOffsetMinutes: number }
  | { type: 'record-start'; phase: RoutePhase; robot: string; append: boolean }
  | { type: 'record-key'; key: RecorderKey }
  /** Opens that RViz again, after it was closed */
  | { type: 'open-rviz'; which: RvizWhich }
  /** Keeps the session's plan (deleted when nothing was recorded) */
  | { type: 'finish-session' }
  /** Deletes the session's plan folder */
  | { type: 'discard-session' }

export type TerminalCommand =
  | { type: 'term-subscribe'; session: string }
  | { type: 'term-unsubscribe'; session: string }
  | { type: 'term-input'; session: string; data: string }
  | { type: 'term-resize'; session: string; cols: number; rows: number }

export type ClientMessage = (SetupCommand & { req: number }) | TerminalCommand

export type ServerMessage =
  | { type: 'snapshot'; snapshot: SetupSnapshot }
  /** replay: the session's scrollback, sent once on subscribe: the terminal starts over with it */
  | { type: 'term-output'; session: string; data: string; replay: boolean }
  | { type: 'result'; req: number; ok: boolean; error: string | null }
