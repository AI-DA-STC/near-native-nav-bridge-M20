# Command Center

The operator console for the coordinated search & discovery demo: three Lynx M20 Pro robot dogs and a Mobile ALOHA search an area for a suspicious box, cordon it off and open it, while one operator gives the instruction, approves the plan and judges the contents. It replaces `demo/demo_gui.py`'s window.

This round it runs on a **scenario replay** of the brief's 16 states (`demo/command_center_design_prompt.md`, section 5). The mission backend that will stream live snapshots does not exist yet; [For the backend](#for-the-backend) says what it must send.

## Run

| | |
|---|---|
| Node | 24 LTS (`.nvmrc`). The devcontainer installs it (`.devcontainer/Dockerfile`). |
| Install | `npm install` (its own dependencies; nothing is shared with the ROS or Python side) |
| Develop | `npm run dev`: http://localhost:5173, also reachable on the robots' LAN (`--host`) |
| Build | `npm run build`, then `npm run preview`. `dist/` is self-contained: no CDN, no external font, no map tiles. |
| Check | `npm test` (Vitest), `npm run lint` (oxlint, then Steiger's FSD rules), `npm run typecheck` |

The **PROTOTYPE** pill at the bottom left steps through the brief's 16 states (← / → anywhere). `?state=7` opens on one of them. Its ★ marks this round's states. The operator's commands work against the replay:
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
    layout/                    header (state chip, clock, pills, attention chips), E-STOP banner, toasts;
                               mission-controls.ts: Start, Stop mission, Force stop, E-STOP (only the app sends them)
    prototype/                 the scenario switcher (prototype only, never with a live source)
    styles/, fonts/
  pages/command-center/        the main screen
    ui/                        phase track and task lanes, fleet, map, Operator, Suspicious item, History
    model/                     snapshot → what each block shows (phases, lanes, robot states, map layers, the
                               operator's turn): every rule about what a fact means lives here
    api/                       the page's commands: instruction, plan decision, verdict; the site map
    lib/                       map projection, the phase columns the track and lanes share
  shared/
    ui/<Component>/            the context-free kit, one public API per component
    api/                       the mission contract, the client, and the scenario replay (mission-scenarios/)
    lib/, config/              formatting (true minus, 91 %, 1:47); robot identity and colours
```

There is no `entities/` or `features/` layer yet, as the brief's section 9 explains. Add one when it is earned:
- the robot-state rules move to `entities/robot` when a Fleet health page needs them too;
- the map renderer moves to `shared/ui` when the Routes page does.

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

## For the backend

What the snapshot needs, against what `demo/demo_gui.py`'s parser of `run_demo.sh` has today:

| | Fields |
|---|---|
| **Parsed today** | Run status and outcome, start and end, Stop and the 8 s before Force stop, what the script waits for (`instruction`, `approval`, `verdict`), phase status, plans, the box (position, distance, confidence, image), the contents (objects, image), the verdict, the raw output |
| **In the output, dropped by the parser** | Phase timestamps; waypoint reached/target/total, patrol laps, waypoint outcomes (SUCCEEDED, TIMEOUT after 125 s); all warnings (it keeps one notice) and the history (it keeps the last event); the camera's retry n/3; refinements; arm pose n/5 |
| **To change** | Plan approval stays pending when a plan is denied (the parser marks it failed); the denial belongs to the plan, which stays in the history as Denied |
| **Needs ROS topics or new script output** | Poses, speed and trails (`/ODOM_relayed_<id>`; the ALOHA on domain 1); bridge state and positions before Start; navigation feedback (distance to the goal); docking correction n/3; the end of the 5 s hold; detection boxes as coordinates (`detect_box.py` and `inspect_box.py` draw them into the JPEGs); live camera frames; E-STOP and each robot's confirmation; the occupancy grid, zones and the box's size |
