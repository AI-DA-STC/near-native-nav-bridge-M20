# Open-RMF for the M20 fleet (`dev-openrmf`)

Open-RMF orchestration for the DeepRobotics M20s: an EasyFullControl fleet adapter,
a library of mission primitives, and a YAML mission runner, so a demo like
*patrol → form up → explore → inspect → regroup → patrol* is a short script rather
than a fleet manager.

It runs on **ROS 2 Jazzy on the laptop only**. The robots are untouched (Foxy, vendor
SLAM/nav): commands go over the vendor UDP API (the same packets as
`nav_cmd_bridge`), and pose comes from `/ODOM_relayed_<id>` or, when that is absent,
from the robot's own UDP status stream.

```
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

**Real robots** (domain 0, relay optional but preferred):

```bash
export ROS_DOMAIN_ID=0 M20_SITE=/repo/rmf/m20_rmf/sites/<your_site>.yaml
ros2 launch m20_rmf m20_rmf.launch.py site:=$M20_SITE robots:=834
m20 status                     # pose source, localized, asleep, battery, activity
m20 go 834 fwd_1
```

The robot must be **standing** (controller) before it will walk; `m20 status`
shows `"asleep": true` until then and the adapter warns on every command.

## Localization without `ssh -X`

`launch/relays.launch.py` now also relays laptop `/initialpose_set_relayed_<id>` →
robot `/initialpose` (the topic the on-robot RViz tool publishes). Then either

* `m20 relocalize 834 home_834` (a site place) or `m20 relocalize 834 x y yaw`, or
* laptop RViz on the relayed TF, "2D Pose Estimate" remapped:
  `rviz2 --ros-args -r /tf:=/tf_relayed -r /tf_static:=/tf_static_relayed -r /initialpose:=/initialpose_set_relayed_834`
  and judge the fit against `/ALIGNED_POINTS_relayed_834` over `/GRID_MAP_relayed_834`.

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
| `estop` | vendor e-stop via the adapter **and** straight over UDP | `m20 estop [834\|all]` |
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
| `/m20/estop` | String (robot id or `all`) | operators → adapter |
| `/initialpose_set_relayed_<id>` | PoseWithCovarianceStamped | laptop → robot relay |

`m20 events` tails the event stream.

## Tests

`python3 -m pytest rmf/m20_rmf/test` in the Jazzy container (protocol framing vs the
C++ bridge, site compilation/validation, arrival/settle/resend/stall logic, UDP
status parsing from real packets, mission checks, slot assignment).
