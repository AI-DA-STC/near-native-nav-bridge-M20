# Changelog — `dev-openrmf` (work in progress)

Open-RMF orchestration for the DeepRobotics M20 fleet. Branched off `dev-nav-relay` at
`6d93419` ("updated readm") on 2026-09-28. Everything below is unreleased and still
changing; see [RUNBOOK.md](RUNBOOK.md) for how to use it.

Scope so far: 11 commits, 43 files, ~5,200 lines added. Tested on mock robots throughout
and on robot **834** (single robot, standing, ~2 m corridor). Not yet run on 741 / 665 or
with several real robots at once.

## Added

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
- No GUI operator console yet (planned: STOP button, status, go/mission buttons).
