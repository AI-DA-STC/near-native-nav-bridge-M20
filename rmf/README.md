# Open-RMF for the M20 fleet (`dev-openrmf`)

Open-RMF orchestration for the DeepRobotics M20s: an EasyFullControl fleet adapter,
a library of mission primitives, and a YAML mission runner, so a demo like
*patrol → form up → explore → inspect → regroup → patrol* is a short script rather
than a fleet manager.

It runs on **ROS 2 Jazzy on the laptop only**. The robots are untouched (Foxy, vendor
SLAM/nav): commands go over the vendor UDP API (the same packets as
`nav_cmd_bridge`), and pose comes from the relays' `/ODOM_relayed_<id>` (10 Hz), with
the robot's own UDP status stream (~1 Hz; also battery, sleep and nav state) as the
fallback when the relay is down.

> **Domains and the laptop bridge.** The robots are left exactly as the team runs them:
> Foxy relays publishing `/<TOPIC>_relayed_<id>` on domain 0. Open-RMF never joins
> domain 0. Instead `launch/laptop_bridge.launch.py` (Foxy package, run in the Foxy
> devcontainer) copies the relayed topics from domain 0 to the RMF domain **20**, and
> commands back. Only Foxy ever talks to the robots, and our traffic stays off the
> domain other people use. The adapter, CLI, mission runner and launch file refuse
> domain 0 unless given `--allow-robot-domain` / `allow_robot_domain:=true`.
>
> **Why Jazzy needs `rmf/fastdds_jazzy.xml`.** Every ROS 2 participant publishes graph
> info on the hidden `ros_discovery_info` topic; its GID field shrank from 24 to 16
> bytes in Iron, and a Foxy process that receives a Jazzy sample dies with
> `Deserialization of data failed` → `std::bad_alloc` (it killed 834's relays twice on
> 2026-09-28; reproduced on the laptop over UDP). The profile moves Jazzy's
> `ros_discovery_info` into its own DDS partition so Foxy never receives it, and uses
> UDP only because the Foxy and Jazzy containers do not share shared memory. With it,
> the bridge ran with zero errors next to the full RMF stack. Humble would not need the
> partition (still 24-byte GIDs) but lacks the EasyFullControl API used here.

```
 laptop, Foxy devcontainer                    laptop, Jazzy devcontainer (this)
 robots ─ domain 0 ─► laptop_bridge ─ domain 20 ─► Open-RMF + m20_rmf
 (relays untouched)   (Foxy, both domains)          (fastdds_jazzy.xml)

 mission YAML / m20 CLI / your script
        │  primitives.py (Fleet): patrol, form_up, explore, inspect, ...
        ▼  rmf_task_msgs/ApiRequest JSON on /task_api_requests
 Open-RMF core ── traffic schedule + blockade, task dispatcher
        ▼  navigate / stop / perform_action callbacks
 fleet_adapter.py (EasyFullControl) ── actions.py (off-graph + non-nav behaviours)
        ▼  robot_client.py: UDP :30000 heartbeat, goals, arrival/stall/resend
 M20 ×N ── vendor nav   ──►  pose: /ODOM_relayed_<id> (10 Hz) or UDP 1002/7 (~1 Hz)
 monitor.py: websocket :7878 ◄─ RMF task states ─► /m20/task_states
```

## Quick start

Open the repo in VS Code and pick **"Open-RMF (ROS2 Jazzy)"** when asked for a dev
container (`.devcontainer/rmf-jazzy/`; the existing Foxy container is unchanged).
It builds `rmf/` into `/ws` on creation; rebuild after edits with `bash rmf/build.sh`.

**Rehearse with mock robots** (no hardware; use a spare domain so real robots are
never addressed):

```bash
export ROS_DOMAIN_ID=42 M20_SITE=/repo/rmf/m20_rmf/sites/sim_lab.yaml
ros2 launch m20_rmf m20_rmf.launch.py site:=$M20_SITE sim:=true viz:=true
m20 mission /repo/rmf/m20_rmf/missions/visitor_demo.yaml      # second terminal
m20 trigger start                                             # third: release the wait
```

**Real robots.** Settings live in **`m20_stack.yaml`** at the repo root (active robots,
the robots' and RMF's domains, the laptop DDS profile, the site file); the bridge launch,
the RMF launch and `m20` all read it, so nothing needs exporting. Command-line
arguments override it (`robots:=834,741`, `site:=...`, `m20 --site ... --robots ...`).

Robots' relays running as usual (domain 0). In the **Foxy** devcontainer:

```bash
source /root/ros2_ws/install/setup.bash
ros2 launch nav_cmd_bridge laptop_bridge.launch.py
```

then in the **Jazzy** devcontainer (domain 20 and the Jazzy profile are preset):

```bash
ros2 launch m20_rmf m20_rmf.launch.py
m20 status                     # pose source, localized, asleep, battery, activity
m20 go 834 fwd_1
```

The robot must be **standing** (controller) before it will walk; `m20 status`
shows `"asleep": true` until then and the adapter warns on every command.

## Running tests on real robots (operator runbook)

**Robot motion is always started by a person at the robot's side, from their own
terminal**, never from an automated session: whoever runs it must be able to stop it.

Terminals: (1) Foxy devcontainer — `laptop_bridge.launch.py`; (2) Jazzy — the
`m20_rmf.launch.py` stack; (3) Jazzy — `m20 events` (live log of every command sent);
(4) Jazzy — your commands. Check `m20 status` shows `registered: true`,
`pose_source: odom`, `asleep: false` before moving anything. Go one step at a time
(`m20 go 834 <place>`) before running a whole mission.

**Stopping**, gentlest first — none of these drops the robot:

1. **Ctrl-C** in the terminal running `m20 mission` / `m20 go …` — stops the robots.
2. **`m20 stop 834`** (or `m20 stop` for all) from any Jazzy terminal — cancels the
   goal straight over UDP, drops the adapter's action, cancels all RMF tasks.
3. **`ros2 run nav_cmd_bridge nav_cmd_bridge cancel --ip <robot ip>`** from the Foxy
   devcontainer — works with RMF and the adapter down.
4. **The handheld controller** — take over or sit the robot down.

Stopping the RMF launch alone does **not** stop a robot: it keeps walking to its last
goal until cancelled. `m20 estop --drop` is the vendor e-stop and **drops the robot**.

Goals are sent walk-then-turn: the M20 holds a goal's final heading while it walks
(so a goal whose heading differs from the travel direction made 834 walk backwards or
strafe), so the adapter walks there facing the travel direction, then turns in place.
Per-robot `nav: {face_travel: false}` in the site file restores single goals.

## Localization without `ssh -X`

`launch/relays.launch.py` now also relays laptop `/initialpose_set_relayed_<id>` →
robot `/initialpose` (the topic the on-robot RViz tool publishes). Then either

* laptop RViz (**Foxy** devcontainer, domain 0) on the relayed TF, "2D Pose Estimate" remapped:
  `rviz2 --ros-args -r /tf:=/tf_relayed -r /tf_static:=/tf_static_relayed -r /initialpose:=/initialpose_set_relayed_834`
  and judge the fit against `/ALIGNED_POINTS_relayed_834` over `/GRID_MAP_relayed_834`.

`m20 relocalize` publishes the same message but from Jazzy, so it only reaches a robot
when a Foxy forwarder bridges the RMF domain (not built yet); until then use RViz.
The `relocalize` action is kept for that setup.

Robots running an image built before this change can start the extra relay by hand
inside the relay container, no rebuild:

```bash
ros2 run nav_cmd_bridge posewithcov_relay --ros-args -r __node:=initialpose_set_relay_834 \
  -p input_topic:=/initialpose_set_relayed_834 -p output_topic:=/initialpose
```

## Laying out a demo: the site file

Everything a mission names lives in one YAML (see the annotated
`m20_rmf/sites/sim_lab.yaml`): `places` (graph waypoints), `lanes`, patrol `routes`,
`formations` (slot places + nearest/fixed assignment), exploration `zones`
(off-graph tracks, entry/exit places), inspection `targets` (approach place,
optional standoff pose, look-at point, dwell, timeout) and `robots` (ip, home, route,
per-robot `nav` overrides such as gait/speed/obs_mode). The adapter compiles it into
the RMF nav graph and fleet config at start-up; `m20 graph` does the same and prints
layout warnings.

Record real poses by walking a robot to each spot and running
`m20 capture 834 muster_1` — it appends a ready-to-paste line to
`<site>.captures.yaml`.

**Spacing rule:** RMF never schedules two robots closer than footprint + vicinity
(1.1 m by default, `fleet.profile`). Formation slots and homes closer than that make
RMF negotiate forever; `m20 graph` warns about it.

## Primitives (mission steps / `Fleet` methods / CLI)

Every primitive takes one robot, a list, or nothing (= all active robots), which is
how fleet-wide and individual commands mix. Motion primitives **preempt**: the
robot's current/queued RMF tasks are cancelled first (pass `queue: true` to append).
Blocking ones return when every robot's task finishes (`wait: false` to run in the
background, then `wait_tasks`).

| step | what it does | CLI |
|---|---|---|
| `patrol` | native RMF patrol of each robot's route (or `route:`) × `rounds`, background by default | `m20 patrol [834] --route r --rounds n` |
| `go_to` | go to a place, optional final `yaw` | `m20 go 834 place [--yaw]` |
| `go_to_pose` | off-graph goal `[x,y,yaw]` | `m20 pose-goal 834 x y yaw` |
| `form_up` | assign formation slots (nearest/fixed), go, **barrier** until all arrive, face slot yaw | `m20 form-up muster` |
| `explore` | each robot enters the zone and walks one track (tracks dealt round-robin, flat pose lists split), returns to the graph | `m20 explore new_area` |
| `inspect` | approach, optional standoff, face target, publish `/m20/inspect/request`, wait for `/m20/inspect/result` (or timeout), return | `m20 inspect box1 834` |
| `action` | any adapter action, optionally `at:` a place first | `m20 action 834 turn_to '{"yaw":1.57}'` |
| `hold` | stand still `seconds` (inside RMF, so traffic knows) | — |
| `turn_to` | `yaw`, `look_at: [x,y]` or `target` | — |
| `return_home` | every robot to its home | `m20 home` |
| `relocalize` | set SLAM pose at a place / pose (direct, works while RMF says lost) | `m20 relocalize 834 home_834` |
| `cancel` | cancel all of a robot's RMF tasks | `m20 cancel [834\|all]` |
| `stop` | **stop where they stand, no drop**: UDP cancel + adapter + RMF task cancel | `m20 stop [834\|all]` |
| `estop` | vendor e-stop — **the robot drops**; needs an explicit flag | `m20 estop --drop 834` |
| `signal` | event on `/m20/events` (lights, sound, dashboard hooks) | — |
| `trigger` | publish `/m20/trigger` (releases `wait_trigger` / `wait_for_event`) | `m20 trigger start` |
| `wait_trigger` | pause for ENTER, a trigger event, and/or seconds | — |
| `wait_tasks` | barrier on background tasks | — |

Control steps in mission YAML: `parallel: [...]`, `repeat: {times, steps}`,
`log: text`, `sleep: s`. Robots named in a mission but not active in this run are
dropped from lists, and a single `robot:` falls back to the first active robot — so
the 3-robot `visitor_demo.yaml` rehearses with `--robots 834`. `m20 mission f --check`
validates names without touching RMF.

## Adapter actions (inside RMF tasks)

Advertised to RMF via the generated fleet config; used by the primitives above and
available to any RMF client (rmf-web, `dispatch_action`) as `perform_action`:

`goto_pose`, `waypoints` (with `loops`, `dwell`), `explore`, `inspect`, `turn_to`,
`dwell`, `stand_up`, `relocalize`, `signal`, `wait_for_event`. Parameters are in the
table at the top of `m20_rmf/actions.py`. Off-graph actions announce their path to
the RMF traffic schedule and, by default, walk back to where they started so RMF
can resume routing. To add one: subclass `Action`, register it in `ACTIONS`, add the
name to `sitefile.ADAPTER_ACTIONS`.

## Relay profile on the robot

Without a profile, Foxy's Fast DDS on the robot advertises only the internal
`10.21.x` addresses (never the Wi-Fi one), so the laptop hears the relays but can never
connect: no `_<id>` topics. The profile must pin unicast locators to the Wi-Fi address
**and** every internal address the DeepRobotics nodes reach the relays on (on 834
`/ODOM` comes from hosts on `10.21.31.x`, so eth0's `10.21.33.103` alone gives no
odometry), with SHM kept on. `robot/fastdds_relay.xml` is the profile 834 runs.

Observed on 834 (2026-09-28): whenever its relays are reachable over Wi-Fi on domain
0, it sends ~180 KiB/s to the other robots and the workstation (.101, .160, .100) and
its ping rises to 0.1–1.6 s; with the relays stopped it drops back to ~35 ms. That is
the shared-domain-0 relay design, not the profile; worth a look before relying on
834's link during a demo (its motion commands share it).

## Robot link details (learned on 834, fw "PRO")

After heartbeats the robot streams Type 1002 status: cmd 3 `ErrorList`, 4
`MotionStatus` (height, velocities, `RemainMile`) + joints, 5 `BatteryList`
(two packs, %), 6 `BasicStatus` (`Sleep`, `MotionState`, `Gait`, `Charge`, …), 7
`NavStatus` + `LocationStatus` (localized flag and map pose). The adapter uses them
for pose fallback, RMF battery state, arrival confirmation and the `asleep` warning.

Arrival = within 0.15 m **and** stopped for 0.6 s (or the robot reports Complete) —
the dog rejects a new goal while its own is active (0xA341), which is also handled by
cancel-and-resend. No progress for 25 s → resend, 3 times, then RMF is asked to
replan. Fatal robot errors (battery, motor temperature, localization, permissions)
fail the goal immediately.

## ROS interface

| topic | type | direction |
|---|---|---|
| `/m20/events` | String (JSON) | adapter/missions → operators |
| `/m20/robot_status` | String (JSON list) | adapter, 2 Hz |
| `/m20/task_states` | String (JSON) | monitor (latched) |
| `/m20/inspect/request` / `result` | String (JSON, matched by `id`; `"latest"` matches any) | adapter ↔ vision |
| `/m20/trigger` | String | operators → waits |
| `/m20/stop` | String (robot id or `all`) | operators → adapter (safe stop) |
| `/initialpose_set_relayed_<id>` | PoseWithCovarianceStamped | laptop → robot relay |

`m20 events` tails the event stream.

## Tests

`python3 -m pytest rmf/m20_rmf/test` in the Jazzy container (protocol framing vs the
C++ bridge, site compilation/validation, arrival/settle/resend/stall logic, UDP
status parsing from real packets, mission checks, slot assignment).
