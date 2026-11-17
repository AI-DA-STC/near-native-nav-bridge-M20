# Command Center: Claude Design prompt

Paste the **Prompt** section below as the first message of a new Claude Design project. The **Follow-up prompts**
at the end are optional next steps, one per message.

Attach with it, from `CrazySwarm2-with-Mocap_Escort-Demo/docs/img/`:
- `console-dashboard.png`: the console's dashboard (header, fleet tiles, stepper, live console)
- `mission-escort.png`: the mission window (scene, then operator/status/fleet column, then timeline and output)
- `console-health.png`: the health diagram (for the later Fleet health screen)

Optional: link the CrazySwarm2 fork as the codebase (the tokens are in `console/mission_console/static/style.css`
and `static/mission/mission.css`), and a screenshot of today's `demo/demo_gui.py` window, captioned "current
window: functions to keep, not the look".

---

## Prompt

Design **Command Center**, an operator console for a live multi-robot demo. Three Lynx M20 Pro robot dogs and a
Mobile ALOHA search an area for a suspicious box, cordon it off and open it to inspect what is inside. A human
operator gives the instruction, approves the plan and judges the contents.

Today the operator uses a plain black-and-white window that lists text. I want a command center that (1) lets one
operator manage the fleet and take the decisions, and (2) makes the mission's phases visible at a glance, to the
operator and to visitors watching over their shoulder.

**This round:** one interactive, high-fidelity desktop prototype of the main screen at 1440×900, with a
prototype-only state switcher for the ★ states in section 5. The rest of the brief is there so the layout leaves
room for everything. The later screens in section 8 only need a place in the navigation. Section 9 only applies once
you export code.

### 1. Visual language: reuse ours, don't invent a new one

The attached screenshots are our CrazySwarm2 "Mission console", built for a drone swarm. Match its look and
component patterns closely, and adapt the drone concepts to ground robots. The orange numbered circles and orange
outlines in the screenshots are documentation callouts, not part of the UI.

Principles to keep:
- Two audiences, one screen: the operator reads it from the desk; a visitor 2 m behind should be able to read the
  current phase and whether anything is wrong.
- One accent colour, meaning "interactive / your turn". Status colours mean status and nothing else. Motion only
  for things that are live: a robot moving, data arriving, the operator needed.
- Tabular figures for numbers; monospace for IDs, coordinates and logs.
- The page never scrolls on desktop; panels scroll inside.
- Say why: a disabled button gives its reason once, and a warning names the robot and the likely fix.

Tokens, from the console's CSS:
- Surfaces: page `#080b10` / `#0b1017`, panel `#111823`, raised `#18212e` / `#212c3c`, terminal and inputs
  `#070a0f`; borders `#232d3c` / `#2f3b4d`.
- Text `#e9eff7`, secondary `#bcc8d8`, muted `#7e8c9f`.
- Accent `#58a6ff` (text on it `#06121f`); secondary accent `#7ee0ff` for code and live highlights.
- Status: ok `#3fb950`, warning `#d8a11d`, fault `#f0564f`, blocked/unknown `#5a6472` / `#7d8794`. Tinted fills
  at about 13 % alpha with about 50 % alpha borders; status text in `#7ee787` / `#e3b341` / `#ff9c93`.
- Type: system-ui, 13–13.5 px body; titles 14.5–16 px semibold; panel titles 11.5 px uppercase with 0.08 em
  tracking in the secondary colour; JetBrains Mono (fallback ui-monospace) for mono.
- Radius 7 / 10 / 14 px, pills fully rounded, soft dark shadows. The header is a slightly lighter gradient band
  with a faint blue radial glow behind it.

Components to carry over:
- The header: brandmark, title and mono subtitle; the big state chip (READY · RUNNING · WAITING FOR YOU in accent
  with a slow pulse · ENDED · ENDED (FAILED)); telemetry pills with status dots; the red E-STOP top right.
- Panels with an uppercase title row and right-aligned meta. A panel turns "hot" (accent border and glow) when it
  needs the operator.
- Fleet tiles with a 3 px status rail down the left edge, a state word in status colour, a large tabular value, a
  thin bar and a muted footer.
- The 2-column indicator tiles, the attention-chip row and the numbered stepper.
- The Timeline (time · TAG · text) and Output (terminal) panels, the confirm modal, toasts, and the E-STOP result
  banner.
- The scene panel with its floating translucent toolbar and its legend chip.
- A brandmark in the same spirit (the console's is a hub with five satellites that turns while something runs),
  e.g. three dog chevrons and one square around a hub.

New in this design:
- **Robot identity colours.** Each robot needs a hue for its map glyph, route and lane. Choose four that stay clear
  of the status colours and the accent (a starting point: R1 cyan `#7ee0ff`, R2 violet `#b392f0`, R3 pink
  `#f778ba`, ALOHA warm white), and always pair the colour with the label.
- **Findings are not faults.** A box found, or contents marked ANOMALY, must never look like a system failure. Give
  findings their own treatment, distinct from fault red.

### 2. The fleet

| Label | Robot | IP | Role in the mission |
|---|---|---|---|
| R1 · 741 | Lynx M20 Pro robot dog | 192.168.123.100 | Patrols; sweeps zone 1; cordons zone 3 |
| R2 · 665 | Lynx M20 Pro robot dog | 192.168.123.101 | Patrols; sweeps zone 2; cordons zone 3 |
| R3 · 738 | Lynx M20 Pro robot dog | 192.168.123.103 | Patrols; sweeps zone 3; a detector on its front camera finds the box, then R3 watches it |
| ALOHA | Mobile ALOHA: omnidirectional wheeled base, two arms, three cameras (front, left wrist, right wrist) | 192.168.123.200 | Drives to the box, docks precisely, opens the lid, photographs the contents |

The live data we have. Design around it and don't invent other telemetry:
- Dogs: pose on the shared map (x, y, heading), speed, whether the robot's bridge is connected, the current
  waypoint and its result (reached, timed out after 125 s, or aborted), the patrol lap, and the shared SLAM
  occupancy grid (map frame, metres).
- R3's camera: connecting, live, or no video and retrying (the detector gives up after 3 tries). Box reports with
  map position, distance from R3, confidence and a snapshot, then refinements as R3 gets closer.
- ALOHA: its navigation goal status; docking (correction 1–3 of 3, then docked, or failed with the reason); arms
  at pose n of 5 (pose 3 = lid open, held 5 s for the photo); the contents photo with the objects outlined and their
  confidences.
- Not wired yet: battery and Wi-Fi link quality. Reserve a slot for each that shows "—".
- The dogs are on ROS domain 0 and the ALOHA on domain 1.

### 3. The mission and its phases

Mission: Coordinated search & discovery. Default instruction: "Execute a systematic sweep of Zone A to scan for
unattended or anomalous items".

| # | Phase | Robots | Operator | Moves on when |
|---|---|---|---|---|
| 0 | Ready | Bring-up: bridges connected, positions arriving, ALOHA ready | Start mission | Started |
| 1 | Patrol | R1–R3 each loop their own perimeter, counting laps, until told otherwise | Types an instruction and sends it (empty sends the default) | Instruction sent |
| 2 | Formation | R1–R3 drive to line slots 1–3 while the planner writes a plan (about 5 s) | — | Plan ready |
| 3 | ◆ Plan approval | The dogs finish reaching their slots | Approve (with a confirm step) or Deny | Approve: phase 4. Deny: back to 1, and the plan stays in the history as Denied |
| 4 | Sweep | Each dog drives its zone's 3 waypoints on its own; R3's camera searches; BOX FOUND, then refined | — | Every route done. If R3's camera gives no video after 3 tries, the sweep ends early: a warning, not a failure |
| 5 | Cordon | R1 and R2 go to cordon points around zone 3; R3 watches the item | — | All in place |
| 6 | ALOHA inspection | Drive to the box, dock (up to 3 corrections), arm poses 1–5. At pose 3 the lid is open and held 5 s for one photo, and a detector lists the objects (classes: screwdriver, drill, pliers, case, scissors, object) | May give the verdict as soon as the photo is in | Arms done |
| 7 | ◆ Verdict | The robots hold | ANOMALY or CLEAR (with a confirm step) | Decision |
| 8 | Return to formation | Only after CLEAR: the dogs drive back to their slots | — | All in slots: COMPLETE. After ANOMALY the mission ends at once and this phase shows as Skipped |

The plan the operator approves, shown as is:

> **Plan SR2-01** · Search zones 1–3 (about 5 min)
> - R1: Sweep zone 1 → Cordon zone 3 → Return to slot 1 → Patrol
> - R2: Sweep zone 2 → Cordon zone 3 → Return to slot 2 → Patrol
> - R3: Sweep zone 3 → Report suspicious item → Watch suspicious item → Return to slot 3 → Patrol
> - ALOHA: Standby → Drive to box → Open lid → Scan contents → Dock

At any time:
- **Stop mission** is graceful, like Ctrl+C in the terminal: no new waypoints are sent, each robot finishes the one
  it is driving to, and the ALOHA's arms freeze where they are. If the mission hasn't ended 8 s later, the button
  becomes **Force stop**.
- **E-STOP** is immediate and global: one click, no confirmation and no keyboard shortcut. Within 3 s a banner
  reports, per robot, "confirmed" with the latency or "NOT CONFIRMED" with the reason. Today's window doesn't have
  it.

Status vocabulary. Steps: pending ○, active ▶, done ✓, failed ✕, stopped ■, skipped –. Plans: Generating,
Awaiting approval, Approved, Executing, Completed, Denied, Stopped, Failed, Not decided.

### 4. What the main screen must show

Propose the layout. One starting point is the console's mission window: the map on the left; Operator, Suspicious
item and Fleet in a right column; Timeline and Output along the bottom; and the new phase track across the top.
When space is tight, keep this priority order:
1. Where the mission is and what comes next.
2. Whether it is the operator's turn, and what they are deciding.
3. Where each robot is and what it is doing.
4. What has been found.
5. What is wrong.
6. History.

Elements:
- **Header.** Brandmark, "Command Center", and the mission name in mono; the state chip; the mission clock
  (elapsed); pills for Fleet 3/3 connected, Positions 3/3, ALOHA ready, R3 camera live and Domains 0 / 1; Start
  and Stop mission; E-STOP.
- **Phase track.** This is new and it's the hero. Phases 0–8 run left to right. Mark the two operator decisions
  differently from the other phases, e.g. a diamond with "YOU". Done phases show their duration. The active phase
  is expanded with live sub-progress, e.g. "Sweep · R1 WP 2/3 · R2 WP 3/3 · R3 WP 1/3". Pending phases are dim,
  Skipped and Failed are visible, and a loop-back mark with a count shows when a plan was denied. It must be
  readable from across the room.
- **Task lanes.** One lane per robot, aligned with the phase track's columns. Each cell is that robot's task in that
  phase, from the plan: done, active with progress, pending, or idle. While the plan awaits approval, the lanes show
  it as a dashed preview. This is where you see who waits on whom, e.g. the ALOHA on standby until the cordon is in
  place. The lanes may collapse into the track at small sizes.
- **Live map.** 2D top-down in metres (map frame, x to the right, y up), with a 3D toggle that can be a placeholder
  for now. It shows:
  - an occupancy-grid placeholder and the three zones;
  - the robots as heading-aware glyphs in their identity colours, with mono labels and fading trails: the dogs
    share one shape, and the ALOHA is a rectangle with two arm dots;
  - the active phase's routes: patrol loops, formation slots, sweep paths with numbered waypoints and the current
    target, and cordon points;
  - once found, the box with a confidence halo that tightens on refinement, and a sight line from R3;
  - the ALOHA's path and dock pose, a scale bar and the axes.

  Give it a floating toolbar (2D / 3D, Follow robot, Reset view, Trails, Layers) and a legend chip.
- **Fleet.** Four robot cards; the dogs share one layout, and the ALOHA's adds docking and arms. Each card shows the
  label and ID, a state word, the current task, a waypoint progress bar, speed, distance to the goal, the pose in
  mono, and the battery and link slots. State words: PATROLLING · LAP 3, TO SLOT, IN SLOT, SWEEPING, CORDON,
  WATCHING ITEM, RETURNING, STANDBY, DRIVING, DOCKING 2/3, DOCKED, ARMS 3/5 · LID OPEN, DONE, STOPPED, FAILED, NOT
  CONNECTED, NO POSITION, STALE 4 s. Clicking a card highlights the robot on the map.
- **Operator.** It turns hot whenever it is the operator's turn, and its content follows the mission:
  - Before the start: the Start button, and what is missing.
  - Patrol: the instruction field, with the default instruction as placeholder, and Send.
  - Formation: "Generating plan…" and what the next decision will be.
  - Plan approval: the plan card with its title, summary, per-robot steps and status badge, plus Approve plan and
    Deny.
  - While the plan runs: what the robots are doing, and what the next decision will be.
  - Verdict: the contents photo, the object list, and ANOMALY / CLEAR.
  - After the end: the outcome summary.
- **Suspicious item.** First R3's camera: a live thumbnail with the detection box drawn, or "No video from R3,
  retrying 2/3". Then the BOX FOUND card: snapshot, x and y, distance, confidence, found at and refined at. Then the
  ALOHA's contents photo, with the objects outlined and listed. Images open in a lightbox.
- **Attention.** Active warnings as chips, each naming the robot and the fix.
- **Timeline.** Time · TAG · text, with the tags OPERATOR, PLAN, FLEET, R1–R3, ALOHA, DETECT and INSPECT.
- **Output**, collapsed by default: the mission script's raw output in a terminal pane, and the plan history (#,
  time, plan, instruction, status).

Everything today's window does must survive: the instruction, approving or denying the plan with a confirm step,
the plan history, the mission steps with their status marks, each robot's status, the box image and map
position, the contents photo and the verdict, the warnings, the last event, the elapsed clock, Start / Stop /
Force stop, the raw output, and enlarging the images.

### 5. States for the prototype switcher

Put a small control outside the UI: a floating pill at the bottom left, plus the ← / → keys. Mark it clearly as
prototype-only. ★ = this round.

1. ★ Ready, with R2 not connected: "Robot 665 not connected: is its bridge running?". Start is disabled and says
   why.
2. ★ Patrol, lap 3, WAITING FOR YOU: the instruction field is hot.
3. Formation, generating the plan.
4. ★ Plan approval, WAITING FOR YOU: the plan card is hot, and the lanes show the dashed preview.
5. Plan denied, back to Patrol: the history shows #1 Denied and #2 Generating.
6. Sweep, R3's camera searching.
7. ★ Sweep, BOX FOUND 1:47 into the sweep and refined once.
8. Sweep, R3's camera with no video, retrying 2/3.
9. Cordon.
10. ALOHA docking, correction 2/3.
11. ★ ALOHA arms at pose 3, lid open, photo being taken.
12. ★ Verdict, WAITING FOR YOU: the contents photo and objects, with ANOMALY / CLEAR hot.
13. Complete: CLEAR, everyone back in formation, 7:42 in total.
14. Ended: ANOMALY, Return to formation Skipped.
15. Failed: "ALOHA not docked after 90 s".
16. ★ E-STOP fired during the sweep. The banner reads: R1 confirmed 210 ms, R3 confirmed 340 ms, ALOHA confirmed
    180 ms, R2 NOT CONFIRMED (no answer).

### 6. Mock data

Metres in the map frame; headings in degrees.

- Map extent: x −5…12, y −12…1. The zones surround the sweep routes: zone 1 to the south-east, zone 2 to the east,
  and zone 3 to the north, around the box.
- Box: centre (4.03, −1.72), 0.60 × 0.38 m.
- Patrol loops:
  - R1: (−3.80, −0.62) → (−2.28, −0.77) → (−2.36, −3.38) → (−4.19, −3.32)
  - R2: (−1.23, −4.53) → (−1.40, −7.05) → (−3.34, −7.06) → (−3.49, −4.65)
  - R3: (−0.16, −6.91) → (3.12, −6.86) → (3.25, −9.31) → (1.00, −9.12)
- Formation slots, all facing +x: 1 R1 (−0.16, −6.93), 2 R2 (0.52, −5.55), 3 R3 (−0.07, −4.34).
- Sweep:
  - R1: (2.76, −9.19) → (5.99, −9.64) → (6.89, −7.40)
  - R2: (4.32, −5.06) → (7.91, −3.56) → (11.21, −0.65)
  - R3: (0.41, −2.60) → (0.89, −0.81) → (3.92, −0.62), ending next to the box
- Cordon: R1 (5.36, −3.85), R2 (6.73, −1.20). R3 watches from (6.14, −0.17).
- ALOHA: dock pose (4.07, −0.50), heading −94° (facing the box). Start it anywhere plausible, e.g. 3 m east of the
  box.
- Detection: found at (4.12, −1.58), 2.9 m from R3, confidence 81 %. Refined to (4.05, −1.70), 1.6 m, 91 %.
- Contents: screwdriver 56 %, pliers 48 %, object 39 %.
- Durations: patrol until the instruction about 1:30, formation 0:40, plan 0:05, sweep 2:00, cordon 0:40, ALOHA
  drive and dock 1:30, arms 0:45, return 0:45. Speeds 0.3–0.6 m/s.
- Raw output for the Output pane:
  ```
  === Sweep: every robot sweeps its zone ===
  [FLEET] Sent: 741 (3 WP), 665 (3 WP), 738 (3 WP) are starting
  [DETECT] Watching robot 738's camera for the box (cpu)
  [FLEET] Robot 738 WP 1/3 SUCCEEDED — actual x=0.392 y=-2.611
  [FLEET] Robot 738 → WP 2/3: x=0.886 y=-0.809 yaw=28.4deg
  [DETECT] Box found by robot 738 at x=4.12 y=-1.58 (map), 2.9 m away, confidence 0.81, image demo/detections/box_20261013_104207_3.jpg
  [ALOHA] Robot aloha docking onto its last WP
  Pose 3/5
  [INSPECT] Box contents: screwdriver 0.56, pliers 0.48, object 0.39; image demo/detections/contents_20261013_104655.jpg
  ```
- Warnings:
  - "Robot 665 not connected: is its bridge running?"
  - "No position yet from robot 738"
  - "Robot 741 still busy with its previous task"
  - "ALOHA waiting for move_base: is its bridge running?"
  - "No video from R3's camera, retrying 2/3"
  - "ALOHA arms still 0.12 rad off after 5 s"

### 7. Constraints

- Desktop and dark only: 1440×900 first, and it must also hold at 1280×720 (panels scroll inside; the page doesn't).
- It runs on the robots' LAN, so no external fonts, CDNs or map tiles. The map is the robots' own occupancy grid,
  not a geographic map.
- Status is never shown by colour alone: there's always a word or icon too. Text contrast at least 4.5:1, and
  visible focus states.
- Confirm steps for Approve plan, the verdict and Stop mission; never for E-STOP.

### 8. Later screens (navigation only for now)

Tabs as in the console: Command center · Fleet health · Routes · Log.
- Fleet health: the console's System health diagram, applied to our bring-up chain.
- Routes: each phase's recorded waypoints per robot, plus the ALOHA's dock pose and arm poses.
- Log: past runs with their plans, verdicts and images.

### 9. Code structure for the export and the Claude Code handoff

This section applies to exported code and to the handoff. This round's prototype can stay a single file. Structure
the code with Feature-Sliced Design v2.1 (fsd.how): start with the fewest layers, and add a layer only when the code
earns it.

Assume a thin client. The backend turns the mission script's output into mission snapshots and events; that parser
already exists in Python, in `demo/demo_gui.py`. The browser only displays them and sends the operator's commands.
That is why there is no `entities/` layer.

```text
src/
  app/
    entrypoint.tsx
    router.tsx              ← "/" is the Command center; the other tabs show disabled until their pages exist
    providers.tsx           ← connects the mission stream for the whole app
    layout/                 ← the app-wide shell: header, tabs, E-STOP banner, toasts
      Header.tsx
      EstopBanner.tsx
      mission-controls.ts   ← Start / Stop / Force stop / E-STOP requests; only the header sends them
      brandmark.svg
    prototype/
      ScenarioSwitcher.tsx  ← prototype-only; drives the scenario replay in shared/api
    styles/
      tokens.css            ← the console tokens and the robot identity colours
      global.css
    fonts/
      jetbrains-mono.woff2  ← bundled, because the robots' LAN has no internet
  pages/
    command-center/
      ui/                   ← CommandCenterPage.tsx, plus one file per block: PhaseTrack, TaskLanes,
                              MissionMap (with the robot glyph SVGs next to it), RobotCard, OperatorPanel,
                              PlanCard, VerdictCard, SuspiciousItemPanel, AttentionChips, Timeline, OutputPanel
      model/                ← phase-track.ts, task-lanes.ts, robot-state.ts, map-layers.ts, map-view.ts
      api/                  ← send-instruction.ts, decide-plan.ts, mark-verdict.ts, fetch-site-map.ts
      lib/
        map-projection.ts   ← map metres ↔ screen pixels
      index.ts              ← exports CommandCenterPage only
  shared/
    ui/                     ← the console's kit, one folder with its own index.ts each: Button, Panel, Pill,
                              StateChip, StatusTile, IndicatorTile, Chip, ProgressBar, Terminal, Modal, Toast,
                              Lightbox, Kbd
    api/
      client.ts
      mission-stream.ts     ← the stream client, the MissionSnapshot / MissionEvent types, useMissionSnapshot()
      mission-scenarios/    ← the prototype's replay of the section 5 states, with its placeholder images
      index.ts
    lib/
      format-clock.ts
      format-measure.ts     ← metres with a true minus, degrees, percentages
public/
  favicon.svg
```

Rules:
- Import only downward: app → pages → shared. Pages never import from `app/`, and slices on the same layer never
  import from each other.
- Import through public APIs only: `@/pages/command-center`, and the segment indexes `@/shared/api` and
  `@/shared/lib`. In `shared/ui`, import each component through its own index, e.g. `@/shared/ui/Panel`. Set up
  path aliases for `@/app`, `@/pages` and `@/shared` only.
- No `widgets/` layer. A panel used on one screen stays in that page, context-free UI goes in `shared/ui`, and the
  app-wide shell goes in `app/`.
- No business rules in `shared/`. Shared knows transport shapes and formatting, never what a phase or a verdict
  means.
- Name files by domain (`phase-track.ts`), never by role (`types.ts`, `utils.ts`, `helpers.ts`).
- Keep each asset next to the code that uses it. Global styles and fonts go in `app/`. Don't create an `assets/`
  folder.

When a layer is earned, and not before:
- **Map renderer:** when the Routes page needs the same map renderer (projection, grid, glyphs), it moves to
  `shared/ui/`. The mission overlays stay in each page.
- **Robot state rules:** when Fleet health and the Command center must agree on them (connected, no position,
  stale), they move to `entities/robot/model/`.
- **Per-robot actions:** when Cancel goal or Stop this robot is offered on two pages, they become
  `features/stop-robot/`.
- **Parsing in the browser:** if the browser ever parses the script's output instead of the backend, the mission
  state machine has two consumers, the header and the page, and becomes `entities/mission/model/`.

Check the structure with Steiger, the FSD linter: `npx steiger src`.

---

## Follow-up prompts

1. Add the other states (3, 5, 6, 8, 9, 10, 13, 14, 15) to the switcher, and a Play control that runs the whole
   mission at 10× so the phase track, lanes, map and timeline advance together.
2. Clicking a robot card opens a drawer with: label, ID, IP and robot type; live pose, speed and last update; its
   plan steps with times; its last 20 events; R3's camera, or the ALOHA's docking and arms; and Cancel goal / Stop
   this robot, each with a confirm step. E-STOP stays global.
3. Make a read-only presentation view for a 1080p TV beside the operator: the phase track, the map and the
   suspicious-item panel in large type, with no controls.
4. Build the Fleet health tab on the pattern of the attached `console-health.png`, for our chain:
   - each dog: localized on the map → relays up on the robot → odometry arriving → bridge connected;
   - the ALOHA: robot services (roscore, cameras, arms, lidar, base, navigation, docking) → bridge to domain 1 →
     navigation, arms, wrist camera and docking answering;
   - the mission: waypoints recorded for every phase, detector model loaded, R3's camera streaming.

   Each box shows what was measured, the command behind it, and the fix. Boxes below a failure go grey as "blocked
   upstream".
5. Build the Routes tab: for each phase (Patrol, Formation, Sweep, Cordon), a small map of each robot's recorded
   waypoints with their counts, plus the ALOHA's dock pose and its 5 arm poses. Add actions to re-record a phase
   or a single robot, append, undo the last waypoint, and clear.
6. Fit the main screen to 1280×720 with no page scroll, and tell me what you collapsed.
7. Prepare the Claude Code handoff: export the main screen as code in the section 9 structure. Replay the section 5
   states through `shared/api/mission-scenarios`, so that switching to the live stream changes no UI code.
