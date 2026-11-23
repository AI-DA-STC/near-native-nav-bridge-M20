# Command Center

The operator console for the coordinated search & discovery demo: three Lynx M20 Pro robot dogs and a Mobile ALOHA search an area for a suspicious box, cordon it off and open it, while one operator gives the instruction, approves the plan and judges the contents. It replaces `demo/demo_gui.py`'s window.

It opens on a landing page (`/`); **Launch** goes through the operator's steps:
- **Setup** (`/setup`): the robots join a lobby one at a time, and the setup server in `server/` brings each one up by typing its commands into terminals on this workstation (the package README's for an M20, `start_aloha.sh` and `aloha/bridge.sh` for the ALOHA).
- **Routes** (`/routes`): the mission plans in `demo/waypoints/<date>_<time>/`, each with a preview, and new routes recorded robot by robot with `demo/record_waypoints.sh`. **Use this plan** points `demo/waypoints/current` at one.
- The **Command center** (`/mission`), with Fleet health, opens once both are confirmed.

**Terminals** (`/terminals`) shows the terminals, live. How to launch it, for the operator: [`../README_gui.md`](../README_gui.md).

The **Command center** (`/mission`) still runs on a **scenario replay** of the brief's 16 states (`demo/command_center_design_prompt.md`, section 5). The mission backend that will stream live snapshots does not exist yet; [For the backend](#for-the-backend) says what it must send.

## Run

| | |
|---|---|
| Node | 24 LTS (`.nvmrc`). The devcontainer installs it (`.devcontainer/Dockerfile`). |
| Install | `npm install` (its own dependencies; nothing is shared with the ROS or Python side) |
| Develop | `npm run dev`: the page (Vite, hot reload) and the setup server, one process on http://localhost:5173. It listens on 127.0.0.1 only: `HOST=0.0.0.0` opens it to the LAN, and with it shells on the robots. |
| Build | `npm run build`, then `npm start`: the built `dist/` and the setup server. `dist/` is self-contained: no CDN, no external font, no map tiles. |
| Check | `npm test` (Vitest: the page in jsdom, the server in Node), `npm run lint` (oxlint, then Steiger's FSD rules), `npm run typecheck` (the app, the configs and the server) |

The Command center opens once Setup and Routes are confirmed; `MISSION_UNLOCKED=1 npm run dev` opens it straight away, on the replay. There, the **PROTOTYPE** pill at the bottom left steps through the brief's 16 states (← / → anywhere). `/mission?state=7` opens on one of them. Its ★ marks this round's states. The operator's commands work against the replay:
- Send moves on to Formation, and the plan arrives about 5 s later.
- Approve plan starts the Sweep; Deny goes back to Patrol.
- ANOMALY ends the mission; CLEAR returns the dogs to their slots.
- Stop mission, Force stop and E-STOP work at any time.

## How it is built

**The design.** The look comes from the [Command Center design system](https://claude.ai/artifact/KDPteXBwxB7F5PWaKCDfQG).
- Its React components were ported from `components/bundle.js` to typed TSX, with the props of its `components/index.d.ts`.
- Its stylesheet is used verbatim, one file per component with the same `cc-` class names. Each file's first line names the component, so it can be diffed against a later bundle.
- `src/app/styles/tokens.css` is the generated `tokens.css`; only the font's path is changed.
- JetBrains Mono ships in `src/app/fonts/` with its OFL licence.

**Deliberate changes from the design system:**
- **E-STOP stays one click away while a confirm modal or the lightbox dims the page** (`src/app/layout/AppShell.css`).
- **Setup and Terminals have no E-STOP.** Setting up moves no robot, so E-STOP is on the Command center only (`src/app/layout/SetupHeader.tsx`).
- **A robot that has not confirmed an E-STOP shows E-STOP NOT CONFIRMED, never STOPPED.**
- **The verdict's photo sits beside its object list in the Operator panel,** so ANOMALY and CLEAR stay in view.
- **During plan approval the Operator panel shows the plan card alone,** with Approve and Deny.
- **A robot card shows distance and speed only while the robot drives to a goal,** so the fleet fits without scrolling.
- **Deny has no confirm step (brief §3).** Approve plan, the verdict, Stop mission and Force stop each have one. E-STOP never does.

**Feature-Sliced Design v2.1.** The layers are `app → pages → shared`, and each imports only downward, through public APIs. The only path aliases are `@/app`, `@/pages` and `@/shared`. Steiger checks the rules on `npm run lint`. The `feature-sliced-design` skill is in `.claude/skills/`, recorded in `skills-lock.json` for `npx skills update`.

```
src/
  app/                         the app-wide shell and wiring
    entrypoint.tsx, router.tsx
    mission-source.ts          connects the mission source once (replay now; the live source goes here)
    setup-source.ts            connects the setup server's socket once
    layout/                    header (state chip, clock, pills, attention chips), E-STOP banner, toasts;
                               mission-controls.ts: Start, Stop mission, Force stop, E-STOP (only the app sends them);
                               SetupHeader and setup-toasts.ts: the header and toasts of Setup, Routes and Terminals
                               (no E-STOP); flow.ts and nav-tabs.ts: Setup, then Routes, then the Command center;
                               FlowRoutes.tsx: the landing page's Launch and the Command center's lock
    prototype/                 the scenario switcher (prototype only, never with a live source)
    styles/, fonts/
  pages/landing/               the hero video, the console's name, the two logos and Launch
  pages/setup/                 the lobby's seats (roster/, with the robot images), the selected robot's steps and
                               prompts (bay/; its terminals are under Terminals), adding a robot with its login (add-robot/);
                               model/: what a seat and a step say; api/: the lobby's commands
  pages/routes/                the plans and their preview (one small map per phase), a recording session and its
                               recorder; model/: the phases' rules and the preview's extent; api/: its commands
  pages/terminals/             every terminal the setup opened, by robot, then the Routes recorder's
  pages/command-center/        the mission screen
    ui/                        phase track and task lanes, fleet, map, Operator, Suspicious item, History
    model/                     snapshot → what each block shows (phases, lanes, robot states, map layers, the
                               operator's turn): every rule about what a fact means lives here
    api/                       the page's commands: instruction, plan decision, verdict; the site map
    lib/                       map projection, the phase columns the track and lanes share
  shared/
    ui/<Component>/            the context-free kit, one public API per component (XtermPane: a live terminal)
    api/                       the mission contract, the client, and the scenario replay (mission-scenarios/);
                               setup-protocol.ts and setup-stream.ts: the setup server's facts and its socket
    lib/, config/              formatting (true minus, 91 %, 1:47); robot identity and colours
```

There is no `entities/` or `features/` layer yet, as the brief's section 9 explains. Add one when it is earned:
- the robot-state rules move to `entities/robot` when a Fleet health page needs them too;
- the map renderer moves to `shared/ui` when another page needs the Command center's map (Routes draws its own small one).

## The data: a thin client

`src/shared/api/mission-stream.ts` is the contract.
- **`MissionSnapshot`**: transport facts with server timestamps (run, phases, plans, robots, camera, detection, contents, verdict, warnings, E-STOP, timeline, raw output).
- **`MissionCommand`**: `start`, `stop`, `force-stop`, `estop`, `instruction`, `decide-plan`, `verdict`.
- **`SiteMap`**: extent, occupancy grid, zones, and the routes recorded in `demo/waypoints/*.json`.
- **`MissionSource`**: the interface a source implements.

The page derives everything it shows from those facts. The replay in `shared/api/mission-scenarios/` is a mock backend: it produces the same snapshots and answers the same commands.

**To go live**, implement `MissionSource` over the backend and connect it in `src/app/mission-source.ts`; no UI code changes.
- Typically a WebSocket carries the snapshots and the commands, with the site map fetched once.
- The source must emit at least once a second, since every clock on screen follows `serverTime`.

## The setup server

`server/` is a small Node server, TypeScript run by Node 24 as it is (type stripping). `npm run dev` and `npm start` start it with the page, on one port.
- `main.ts`: the HTTP server (Vite in middleware mode, or `dist/`) and the WebSocket `/api/setup`, which refuses other origins.
- `setup-hub.ts`: the robots added in the lobby with their logins (`server/robots.json`, not in git, mode 0600; passwords never go to a browser), whether they answer (`presence.ts`: a TCP connect every 2 s), their setup runs and terminals, the plans and the recording session, and the operator's flow (Setup and Routes confirmed). It sends the browsers a snapshot on every change, and the output of the terminals they open. `GET /api/plans/<id>` serves a plan's waypoints for its preview.
- `m20-setup.ts`: an M20's six steps. It types the README's commands (`readme-commands.ts`) into two pseudo-terminals (`terminal-session.ts`) once the prompt is back, and reads what they printed (`shell-prompt.ts`, `command-output.ts`): the commands are typed as written, so there are no exit codes. `step-shell.ts` and `ssh-login.ts` hold what both kinds do alike: typing, the step runner, ssh with a password prompt when it is refused.
- `aloha-setup.ts`: the ALOHA's four steps: ssh as agilex, `bash start_aloha.sh` (left attached to its tmux; detached with Ctrl+b d, never Ctrl+C), its eight parts checked on its ROS master (`ros1-master.ts`: XML-RPC `getSystemState`, no ROS 1 needed here), then `aloha/bridge.sh` and the ALOHA's topics on ROS_DOMAIN_ID=1.
- `route-plans.ts`: the plan folders of `demo/waypoints` (or `PLANS_DIR`), checked against the robots added in Setup (who takes part in each phase, and no robot run_demo.sh would wait for), a session as a copy of its base with only those robots, and `current`. `route-recorder.ts` types `ONLY="<id>" WAYPOINTS=… demo/record_waypoints.sh <phase>` (the ALOHA's phase is `aloha`) into the Routes terminal and sends fleet_management.py's keys; `fleet-output.ts` reads its `[FLEET]` lines.
- `mission-hub.ts`: the Command center's live facts on `/api/mission`: the robots added in Setup in their mission roles, their poses, the blockers, the dogs' SLAM map (`map_grid.py`), the site from the plan in use (`mission-site.ts`). `mission-run.ts` runs `demo/run_demo.sh` in the Mission terminal and answers it; `mission-output.ts` reads its output into phases, plans, routes, docking, arms and photos.
- `routes-rviz.ts`: the RViz a recording draws in, one for the dogs (ROS_DOMAIN_ID=0) and one for the ALOHA (1), each in its own terminal. It writes `server/rviz/routes.rviz` from `routes.rviz` (the first dog's map, each dog's odometry) and `routes_aloha.rviz`, both showing `/fleet_goal_markers`, with the 2D Goal Pose tool on `/fleet_goal`.
- `ros-checks.ts`: what it checks without typing: a relay already publishing `/ODOM_relayed_<id>` before it launches one, the poses arriving on `/initialpose_relayed_<id>`, a robot's odometry (the ALOHA's `/amcl_pose`) while it is recorded, and the ALOHA's topics on ROS_DOMAIN_ID=1.
- `rviz-config.ts`: the RViz of step e. It writes `server/rviz/robot_<id>.rviz` (not in git) from `robot.rviz` with `ROBOT_ID` replaced, and rviz2 is typed with `-d` and that file in front of the README's arguments, so each robot's window shows its own map, odometry and waypoints and is named after it.
- node-pty comes from `@lydell/node-pty`, pinned: it ships a Linux binary, while the upstream package compiles on install and focal's g++ 9 cannot build it for Node 24.

`readme-commands.test.ts` fails when README.md, `launch/relays.launch.py` or `aloha/robot/start_aloha.sh` no longer say what the server types or expects. It also checks the RViz marker colours against fleet_management.py's. `m20-setup.test.ts`, `aloha-setup.test.ts`, `route-recorder.test.ts` and `routes-rviz.test.ts` run the steps, the recorder and the RViz windows against scripted terminals.

## For the backend

What the snapshot needs, against what `demo/demo_gui.py`'s parser of `run_demo.sh` has today:

| | Fields |
|---|---|
| **Parsed today** | Run status and outcome, start and end, Stop and the 8 s before Force stop, what the script waits for (`instruction`, `approval`, `verdict`), phase status, plans, the box (position, distance, confidence, image), the contents (objects, image), the verdict, the raw output |
| **In the output, dropped by the parser** | Phase timestamps; waypoint reached/target/total, patrol laps, waypoint outcomes (SUCCEEDED, TIMEOUT after 125 s); all warnings (it keeps one notice) and the history (it keeps the last event); the camera's retry n/3; refinements; arm pose n/5 |
| **To change** | Plan approval stays pending when a plan is denied (the parser marks it failed); the denial belongs to the plan, which stays in the history as Denied |
| **Needs ROS topics or new script output** | Poses, speed and trails (`/ODOM_relayed_<id>`; the ALOHA on domain 1); bridge state and positions before Start; navigation feedback (distance to the goal); docking correction n/3; the end of the 5 s hold; detection boxes as coordinates (`detect_box.py` and `inspect_box.py` draw them into the JPEGs); live camera frames; E-STOP and each robot's confirmation; the occupancy grid, zones and the box's size |
