# Changelog — `dev-openrmf` (work in progress)

Open-RMF orchestration for the DeepRobotics M20 fleet. Branched off `dev-nav-relay` at
`6d93419` ("updated readm") on 2026-09-28. Everything below is unreleased and still
changing; see [RUNBOOK.md](RUNBOOK.md) for how to use it and [SETUP.md](SETUP.md) for
reproducing the environment (Open-RMF installation, containers, keys, robot profile)
on another laptop.

Scope so far: 11 commits, 43 files, ~5,200 lines added. Tested on mock robots throughout
and on robot **834** (single robot, standing, ~2 m corridor). Not yet run on 741 / 665 or
with several real robots at once.

## Added

### Wi-Fi load with three robots (2026-09-29 evening)
- With all three relays running, the laptop's one Wi-Fi link (robots and internet
  share it) stalled: both relays were **reliable** (every lost fragment resent) and the
  map relay forwarded every live SLAM map. Now `robot_relay: odom` relays odometry
  only, **best effort** (a lost pose is replaced by the next), and the laptop bridge
  matches; `odom+map` adds the live map when needed (`m20 map-save`, or a site without
  a `map:` file). Tested on the laptop: fake robot `/ODOM` at 30 Hz -> best-effort
  robot relay -> bridge -> `m20 pose`: 30 Hz, correct pose. Not yet on the robots.
- `scripts/m20_stack.sh netcheck`: Wi-Fi receive/send rate, each robot's relayed
  odometry/map rate and bandwidth, ping, internet response. Runs on its own.

### Three robots: robot-side checks (2026-09-29)
- **Relay profile:** the launcher now always copies `robot/fastdds_relay.xml` (robot IP
  substituted) to `/root/m20_relay_profile.xml` in the relay container and runs the
  relays with it (`robot_profile` in `m20_stack.yaml`). Before, it installed one only if
  the container had none, and the containers on 665 / 741 mount the team's own
  `~/fastdds_relay.xml`, which lacks the localizer address `10.21.31.103`: those relays
  would have shown topics but no odometry (as 834 did before its fix). The team's file
  is not touched.
- The relay pane says plainly when the robot user cannot use `docker` (741).
- Robots: `near-robots-5G` gets `autoconnect-priority 10` (all three, done by hand):
  741 had booted onto the old `near-robots-2.4G` network as `192.168.8.101`.

### Exploring an area on request (2026-09-29)
- **Zones by boundary:** `boundary: [[x, y], …]` (3+ corners) + `spacing` / `margin` /
  `angle`; the site generates a back-and-forth sweep inside it (`sitefile.sweep`),
  drawn with the boundary on the map. `m20 zone corner <zone> --from <robot>` records
  corners; `m20 zone set|clear|rm`.
- **Places as corners:** `boundary` entries may be place names
  (`m20 zone corner <zone> --place <name>`); the corner follows the place when it is
  moved, and `m20 place rm` refuses a place that is a corner.
- **Exit place:** a zone's `exit` (default: its `entry`) is where explorers rejoin the
  graph, after the sweep or when time is up; the return leg is part of the path
  announced to RMF's traffic schedule.
- **`explore: {…, seconds: N}`:** a time limit: stop, walk to the exit, end normally.
- **`repeat: {times: forever}`** (until STOP). `--check` flags zones with nothing to walk.
- **`m20 trigger` and `m20 stop` from a terminal were unreliable:** a fresh process
  published before discovering the others (its own subscription made the subscriber
  count non-zero), so the signal, or a stop's "end the mission", could be lost. Fresh
  processes now wait for discovery and for delivery acknowledgements. The GUI was not
  affected (long-lived).
- **GUI Start list:** it was checked against the site as it was when the `ui` pane
  started, so a mission needing a zone added later never appeared. The hub now re-reads
  the site, open pages get the list again when what fits changes (every 2 s), and an
  empty list says "no mission fits this site".
- An identical signal within 1 s counts once (a double-click is one request).
- Site edits are no longer blocked by missions that were already invalid (e.g. a
  mission written before its zone is finished).
- `missions/triangle_watch.yaml`: patrol the triangle, explore on request, patrol again.

### Full-screen map console (2026-09-29)
- The web GUI is one screen that never scrolls: the map (the RViz view) fills it, the
  phase and operator prompts float over its top edge, robots / signals / log are in a
  right sidebar (a strip below the map on narrow screens). The map fits the site into
  the area below the phase panel.
- An inspection that ends without a verdict (timeout, stop) no longer leaves its
  Clear / Threat card up: it clears when the robot leaves INVESTIGATE, with a log line.
- **Relative paths mean the repo root everywhere** (`stack.path`): `--site`, mission
  files, `--out`, `site new`, `site:=` in both launch files, and the `ui`, `viz`,
  `mission`, `mock_robot` and `fleet_adapter` executables. Before, they were relative to
  the shell's directory, and the devcontainer terminals start in `/`, so
  `m20 site new rmf/m20_rmf/sites/x.yaml` wrote to `/rmf/...` inside the container, not
  the repo. Files the tools create in the repo (site new, map-save, graph --out) get the
  folder's owner instead of root. The operator pane starts in `/repo`.
- `m20 site new <file> --from <robot>`: starts a site file (the robot, its home at its
  current pose, every section commented) for the place/lane/route commands to grow.
- `m20 capture` removed: `m20 place set <name> --from <robot>` writes the place into
  the site instead of a side file to paste from. `m20 pose` stays (read-only).
- `m20_rmf.launch.py monitor_port:=…` (default 7878), so a mock rehearsal can run next
  to the live stack on another domain without reporting into its task monitor.
- `scripts/m20_stack.sh restart` now waits for the pane's command to end after Ctrl-C
  (it could not tell before, as every pane runs under bash).

### Map in the console, site editing from the CLI (2026-09-29)
- **Map panel in the web GUI:** the RViz view in the page. The hub forwards RViz's own
  `/m20/viz` markers and `/m20/map` (the SLAM map) and the page draws them top-down
  (`ui/map.js`, canvas; zoom / pan / fit), so it always matches RViz and works on a
  tablet; RViz itself becomes optional (`M20_RVIZ=false`).
- **Site editing:** `m20 place ls|set|rm`, `m20 lane add|rm`, `m20 route set|rm`
  (`siteedit.py`). Line-based, so comments survive; each edit shows a diff and is
  checked (site loads, no place left without lanes, missions still validate) before it
  is written; `--from <robot>` records the robot's current pose; `--dry-run`.
- The RViz markers (and so the GUI map) follow edits to the site file live;
  `scripts/m20_stack.sh restart <pane>` (e.g. `restart rmf` to route on the new graph).
- `test_834_corridor.yaml` uses `phase:` steps, so the GUI names each stage.
- Tests: `test/test_siteedit.py`; 66 passing.

### One stop, mission host, faster console (2026-09-29, after the first GUI test on 834)
- **One stop.** The GUI's Abort is gone. STOP ALL, per-robot Stop, `m20 stop` and Ctrl-C
  all do the same thing: the robots stop standing, their tasks are cancelled, and the
  running mission **ends**. Before, a Stop cancelled the robot's task but the mission went
  on to its next step (834 walked home), and Abort left the GUI stuck on *running*.
- **Ctrl-C works during cleanup.** Our tools no longer install rclpy's signal handlers,
  which shut ROS down on Ctrl-C before the mission could cancel its tasks
  (`RCLError: publisher's context is invalid` — the cause of the stuck state).
- **Mission host** (`m20 mission-host`, new tmux pane `mission`): runs the missions the
  GUI starts, in view, where Ctrl-C aborts the mission and stops its robots; replaces the
  GUI's hidden subprocess (`/tmp/m20_mission.log`). One host at a time (a second refuses
  to start). Missions run on a worker thread and abort within ~0.2 s from any wait
  (RMF task, signal, button, sleep, parallel branch); no new task starts after a stop.
- **No soft-lock:** a running mission re-publishes its state every second; if it stops
  doing so the GUI shows *Mission lost* and allows a new Start. STOPPED decays to IDLE
  after 15 s. A mission that cannot start (bad file) shows *Mission failed* with why.
- **Faster console:** the view is pushed 5×/s and immediately after any command or
  mission change; the adapter publishes status at 5 Hz; STOP answers after the UDP stop
  (RMF cancellations finish in the background); sections re-render only when they change
  (a button no longer loses clicks to the refresh); buttons dim until the hub confirms;
  errors appear as a banner (no browser alert); a red banner when the hub is unreachable.
- **Prompt-only waits** (`wait_trigger: {prompt: …}`) get a GUI button (signal `continue`).
- **Relay pane stays in SSH:** if the relay ends or the link drops it prints why (exit code,
  time) and reconnects every 5 s, first ending any relay a dropped connection left running
  in the robot's container; Ctrl-C stops it. SSH keep-alive tolerates 30 s of silence.
- Tests: `test/test_abort.py` (abort from every kind of wait, final states, heartbeat,
  stop semantics); 54 passing.

### Demo console and RViz (2026-09-29)
- **Web GUI** (`m20_rmf ui`, http://localhost:8080): mission picker / Start,
  **STOP ALL** and per-robot Stop (no drop), the mission **phase** in large type, one
  call-to-action card only when the mission waits for the operator or an inspection needs
  a verdict (Clear / Threat), one card per robot with a single colour-coded **mode**
  (PATROL, REGROUP, EXPLORE, INVESTIGATE, RETURN, MOVE, HOLD, IDLE, SITTING, STOPPED,
  OFFLINE), mission signal buttons (queued if pressed early), a short log.
- **Status hub** (in the GUI process, `view.py`): one fleet view from adapter status, RMF
  task labels, mission state and inspections, published on `/m20/fleet_view`; the GUI
  and RViz both render it. Short gaps between consecutive tasks keep the last mode.
- **RViz** (`m20_rmf viz` + `rviz/m20_demo.rviz`, `demo.launch.py`): site lanes, places,
  formation slots, exploration tracks, targets, and each robot oriented in its mode colour
  with its remaining path, **over the robot's SLAM map** (`/m20/map`: the site's saved
  `map:` or the live relayed map). `m20 map-save <robot> <name>` saves a map
  (`mapfile.py`, ROS map_server format); `maps/lab_834.yaml` saved from 834.
- **Missions:** `phase:` step; mission header `signals:` (GUI buttons, with data);
  `wait_trigger` signals are buffered (pressing early works); later steps can use a
  signal's data as `${event.key}`; missions publish their state on `/m20/mission`.
  `visitor_demo.yaml` rewritten as the scripted story with phases and operator signals.
- **Adapter** status now carries each robot's current goal and action (kind, detail,
  remaining path, awaiting-verdict).
- **Launcher:** `ui` pane (GUI + RViz), `scripts/m20_stack.sh relay` (relays only),
  relay default = odometry **+ SLAM map**; the relay command starts the robot's relay
  container if stopped, recreates it from `~/docker-compose.yml` if gone, and installs the
  relay profile only if missing; X access for RViz granted on `up`.
- `rmf/SETUP.md`: reproducing this setup on another laptop.

### Open-RMF stack for the laptop (`rmf/m20_rmf`, ROS 2 Jazzy) — `6599c02`
- **Fleet adapter** (`fleet_adapter.py`, Open-RMF EasyFullControl) driving M20s over the
  vendor UDP API (the same packets as `nav_cmd_bridge`, ported to Python in
  `protocol.py` / `robot_client.py`): heartbeats, goals, arrival (within 0.15 m *and*
  stopped, or robot-reported complete), stall detection with resend, fatal-error
  detection, cancel-and-resend on "already executing" (0xA341).
- **Pose, battery and state from the robot's own UDP status stream** (Type 1002:
  LocationStatus, BatteryList, BasicStatus, NavStatus, ErrorList), discovered on 834.
  Used as a fallback when relayed odometry is absent; battery feeds RMF.
- **Adapter actions** (run inside RMF tasks, `actions.py`): `goto_pose`, `waypoints`,
  `explore`, `inspect`, `turn_to`, `dwell`, `stand_up`, `relocalize`, `signal`,
  `wait_for_event`. Off-graph actions announce their path to RMF traffic and return
  to where they started.
- **Mission primitives** (`primitives.py`): `patrol`, `go_to`, `go_to_pose`,
  `form_up` (nearest/fixed slot assignment + barrier), `explore` (tracks split over
  robots), `inspect` (request/result hook for the vision model), `action`, `hold`,
  `turn_to`, `return_home`, `relocalize`, `cancel`, `signal`, `trigger`,
  `wait_trigger`, `wait_tasks`. Motion primitives pre-empt the robot's queued tasks.
- **Mission runner** (`mission.py`): YAML missions with `parallel`, `repeat`, `log`,
  `sleep`; robots absent from a run are dropped/substituted; `--check` validates names.
- **Site files** (`sitefile.py`): one YAML per demo (places, lanes, routes, formations,
  zones, targets, robots) compiled to the RMF nav graph and fleet config; validation and
  spacing warnings.
- **`m20` CLI** (`cli.py`): status, pose, capture, graph, go, pose-goal, patrol,
  form-up, explore, inspect, action, home, cancel, trigger, inspect-result, events,
  mission.
- **Task monitor** (`monitor.py`): the websocket RMF reports task states to, republished
  on `/m20/task_states` (stand-in for rmf-web).
- **Mock robots** (`mock_robot.py`) speaking the UDP protocol for offline rehearsal.
- **Jazzy devcontainer** (`.devcontainer/rmf-jazzy/`), separate from the team's Foxy one.
- Sites `sim_lab.yaml` (3 mock robots), missions `visitor_demo.yaml`.
- Unit tests (`rmf/m20_rmf/test`, 27 so far).

### Laptop-side localization check — `4c8a0bb`
- `scripts/localize.py` (Foxy): scores the live cloud against the robot's map and
  searches ±1 m / ±20° for a better pose; `--apply` / `--pose` send it. Sending needs the
  `initialpose_set` relay (below), which the robot image does not have yet.
- `relays.launch.py`: `initialpose_set` (laptop → robot `/initialpose`) and
  `LOCATION_STATUS/MATCHING_ERROR` relays. **Only effective once the robot image is
  rebuilt** (the team's image; not deployed).

### Two-domain relays — `8046649`
- `relay.hpp` `DomainNode`: one relay process can read on one DDS domain and publish on
  another (second rclcpp context). `relays.launch.py` gains optional `LAPTOP_DOMAIN_ID`
  (unset = unchanged behaviour). Used by the laptop bridge; not deployed on robots.

### Laptop bridge (robots untouched) — `957e39f`
- `launch/laptop_bridge.launch.py` (Foxy devcontainer): copies the robots' relayed
  topics from domain 0 to the RMF domain 20 (and goals back), so Open-RMF never joins
  domain 0 and nothing is installed on the robots.
- `rmf/fastdds_jazzy.xml`: lets Jazzy share a domain with Foxy (see Fixed).

### Safe stop, runbook — `768ad35`
- `m20 stop [robot|all]` / `Fleet.stop()`: cancel over UDP, drop the adapter's action and
  current task (`/m20/stop`), cancel all RMF tasks, cancel over UDP again. **The robot
  stays standing.** Ctrl-C on `m20 go` / `m20 mission` does the same.
- Operator runbook section in `rmf/README.md`.

### Settings file — `cfb2960`
- `m20_stack.yaml` (repo root): active robots, robots'/RMF domains, laptop DDS profile,
  site file. Read by the bridge launch, RMF launch and `m20`; nothing to export.

### Shared-memory cleanup — `b3f879e`
- `scripts/shm_clean.py`: removes Fast DDS `/dev/shm` files no running process uses.
- The bridge launch runs it at start and runs its own nodes UDP-only.

### One-command launcher — `1009131`
- `scripts/m20_stack.sh up|down|status|attach`: starts both devcontainers if needed and a
  tmux window with panes for each robot's relay (started over SSH), bridge, RMF, event
  log and an operator shell. Never sends motion. Settings from `m20_stack.yaml`
  (`robot_relay: odom|full|none`, SSH user/key, container, relay profile).

### Examples — `4f32ac8`
- `missions/examples.yaml`: runnable building blocks (graph moves with headings, custom
  paths with laps, patrols, parallel/staggered robots, triggers, turns, holds, repeats).
- Sites `lab_834_test.yaml`, `lab_834_corridor.yaml` (834 test corridors).

## Changed
- RMF runs on **domain 20** (Jazzy devcontainer preset) instead of the robots' domain 0;
  adapter, CLI, mission runner, mocks, monitor and launch refuse domain 0 unless
  `--allow-robot-domain` — `2087caf`, `957e39f`.
- **Moves are turn → walk → turn** — `768ad35`, `43b1b61`: the M20 turns towards a goal's
  heading while walking, which made 834 walk backwards/strafe. Now it turns in place to
  face the travel direction, walks straight, then turns to the final heading
  (`nav: {face_travel: false}` per robot to disable).
- **`go_to` ends at the place's own heading** from the site file (was: arrival
  direction); `--yaw` overrides, `--face-travel` restores the old behaviour — `43b1b61`.
- The vendor e-stop (robot **drops**) is no longer reachable from ROS; only
  `m20 estop --drop` — `768ad35`.
- `m20_stack.yaml`'s robot list applies only with its own site; other sites default to all
  their robots — `4f32ac8`.
- Root `README.md`: laptop-side localization notes, relay profile notes, pointer to `rmf/`.

## Fixed
- (2026-09-29) GUI process ignored SIGTERM and kept its ports; tmux session names
  prefix-matched (`m20` vs `m20-relays`); map loader read unknown cells as free
  (now map_server's `free_thresh: 0.196`).
- **Jazzy crashing the Foxy relays** (`Deserialization of data failed` → `bad_alloc`):
  Jazzy's hidden `ros_discovery_info` uses 16-byte GIDs (Iron+), Foxy expects 24.
  `rmf/fastdds_jazzy.xml` puts it in its own DDS partition; UDP-only because the Foxy and
  Jazzy containers do not share `/dev/shm` — `957e39f`.
- Adapter crash loop when RMF refuses a robot far from the nav graph — now logs the
  nearest place and retries every 5 s — `957e39f`.
- `/dev/shm` in the Foxy devcontainer filling up (888 stale segments) — `b3f879e`.
- Mission runner surviving SIGTERM; one-shot publishes lost to DDS discovery; client
  shutdown abort; stall detection counting the first sample as progress; module named
  `site.py` shadowing Python's `site` — all in `6599c02`.

## Outside git (state on machines)
- **Robot 834**, relay container `user-nav_cmd_bridge-1`: `/root/fastdds_relay.xml` pins
  unicast locators to the Wi-Fi address **and** all three internal addresses
  (`10.21.31/32/33.103`) with SHM on — needed for `/ODOM` to reach the laptop (copy in
  `robot/fastdds_relay.xml`). Everything else on 834 was removed; the image's files are
  back to `6d93419` (colcon regenerated some build/install metadata, functionally
  identical).
- **SSH key** for the launcher: one per laptop (SETUP §6); remove it from each
  robot's `authorized_keys` when it is no longer needed.
- Laptop `fastdds_profile.xml`: whitelist IP changed `.160` → `.196` (uncommitted, yours).

## Findings worth remembering
- Without a profile, Foxy on the M20 advertises only internal `10.21.x` addresses; the
  laptop hears the relays but never connects.
- 834's localizer runs on hosts behind `10.21.31.x`; an eth0-only profile gives no `/ODOM`.
- With the **full** relay set reachable on domain 0, 834's ping rises to 0.1–1.6 s (other
  robots and the workstation pull its topics); the odometry relay alone is fine.
- The UDP status `Location` flag's meaning is unconfirmed (1 before a reboot, 0 after,
  while RViz showed a good pose).
- Same-host containers pick shared memory; if they don't share `/dev/shm`, DDS data is
  silently lost. Test cross-container DDS over UDP and check data actually arrives.
- Robot clock is 2024 vs image 2026: `make` skips rebuilds on the robot.

## Known issues / open items
- Not yet tested on 834 after the turn → walk → turn change, nor on 741 / 665, nor with
  several real robots together.
- Laptop relocalization (`localize.py --apply`, RViz on the laptop) needs the robot image
  rebuilt with the new `relays.launch.py` — team decision.
- 834 Wi-Fi load with the full relay set; the shared-domain-0 relay design is worth
  revisiting with the team.
- Object recognition for `inspect` is a hook only (`/m20/inspect/request` → result).
- `m20 relocalize` (Jazzy) cannot reach robots without a Foxy forwarder.
- GUI/RViz tested end to end on three mock robots and read-only on 834 (sitting); not yet
  with 834 moving under a GUI-started mission.
