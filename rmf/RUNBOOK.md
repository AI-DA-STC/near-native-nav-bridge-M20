# Runbook — M20 fleet with Open-RMF (`dev-openrmf`, work in progress)

How to set up, run, stop and extend the Open-RMF stack for the DeepRobotics M20s as it
stands now. Changes are listed in [CHANGELOG.md](CHANGELOG.md); design notes and the
full reference are in [README.md](README.md). This is not final.

**Safety rule: robot motion is always started by a person standing by the robot, from
their own terminal.** Never from an automated session — whoever starts it must be able
to stop it.

---

## 1. What runs where

```
 robot (untouched)               laptop, Foxy devcontainer          laptop, Jazzy devcontainer
 ┌───────────────────┐  domain 0  ┌──────────────────────┐ domain 20 ┌─────────────────────┐
 │ relay container    │──────────►│ laptop_bridge        │──────────►│ Open-RMF + m20 CLI  │
 │ /ODOM → /ODOM_     │  (Wi-Fi)   │ (copies *_relayed_*) │  (UDP)     │ fleet adapter       │
 │   relayed_<id>     │           └──────────────────────┘           └──────────┬──────────┘
 │ vendor nav + SLAM  │◄────────────────── UDP :30000 goals / status ───────────┘
 └───────────────────┘
```

- **Robots** run their normal Foxy relays on domain 0. Only one config file is special
  (the relay DDS profile, §2.3).
- **Foxy devcontainer** (the team's `.devcontainer/`): the laptop bridge, domain 0 → 20.
- **Jazzy devcontainer** (`.devcontainer/rmf-jazzy/`): Open-RMF, the M20 fleet adapter,
  the `m20` CLI and missions, on domain 20. Commands reach the robots over the vendor
  UDP API, not ROS.
- Settings: **`m20_stack.yaml`** at the repo root.

| Robot | IP | Notes |
|---|---|---|
| 741 | 192.168.123.100 | SSH key not installed yet |
| 665 | 192.168.123.101 | SSH key not installed yet |
| 834 | 192.168.123.102 | SSH key installed; relay profile set up |
| laptop | 192.168.123.196 | in `fastdds_profile.xml` whitelist |

---

## 2. One-time setup

### 2.1 Devcontainers
Open the repo in VS Code once per container: **Dev Containers: Reopen in Container** →
"ROS2 Foxy", and in a second window **Open Folder in Container…** → "Open-RMF (ROS2
Jazzy)". After pulling changes to `.devcontainer/rmf-jazzy/`, rebuild that container.
(`scripts/m20_stack.sh up` also starts them if they exist but are stopped.)

### 2.2 Laptop DDS profile
`fastdds_profile.xml` must whitelist the laptop's current Wi-Fi address
(`ip -4 addr` → e.g. `192.168.123.196`).

### 2.3 Each robot
1. **Relay DDS profile** in the relay container as `/root/fastdds_relay.xml`: copy
   `robot/fastdds_relay.xml` and set the robot's own Wi-Fi (p2p0) address. It must list
   the Wi-Fi address *and* `10.21.31.103`, `10.21.32.103`, `10.21.33.103`, with SHM on;
   otherwise the laptop sees no topics or no `/ODOM`. Edit the address in a copy first
   (the file in the repo has 834's `192.168.123.102`), then:
   ```bash
   scp robot/fastdds_relay.xml user@<ip>:/tmp/ && ssh user@<ip> \
     'docker cp /tmp/fastdds_relay.xml user-nav_cmd_bridge-1:/root/fastdds_relay.xml'
   ```
2. **SSH key** so the launcher can start the relay:
   `ssh-copy-id -i ~/.ssh/id_m20.pub user@<ip>` (SETUP §6).
3. Add the robot to the site file (`robots:` with `ip`, `home`, optional `route`) and to
   `robots:` in `m20_stack.yaml`.

---

## 3. Before each session
1. Robots on, joined to `near-robots-5G`, relay container up (`docker ps` on the robot).
2. **Localized**: check with the on-robot RViz (laptop-side relocalization needs a newer
   robot image, see CHANGELOG).
3. Robots **placed near a place of the site** (RMF only accepts robots on/near the nav
   graph) with the planned area clear.
4. `m20_stack.yaml` points at the right `site:` and `robots:`.

---

## 4. Start the stack

```bash
scripts/m20_stack.sh up          # on the host, from the repo root
```

A tmux window opens with one pane per process (click to focus; `Ctrl-b d` detaches,
`scripts/m20_stack.sh attach` returns). It also grants the containers access to your
display (for RViz) and opens RViz and the demo console (§5).

| Pane | What it is | Healthy when |
|---|---|---|
| `relay <id>` | SSH → robot → relay container → odometry + SLAM-map relays. Stays in SSH showing the relay output; if the link drops or the relay ends, it says why and reconnects every 5 s (clearing any relay left behind). Ctrl-C stops it for good | `Relay: /GRID_MAP -> …` and `Relay: /ODOM -> /ODOM_relayed_<id>` |
| `bridge` | Foxy: rebuild if needed, `shm_clean`, laptop bridge | `robots [...], domain 0 -> 20 ...`, then `Relay:` lines (2 shared + 4 per robot) |
| `rmf` | Jazzy: rebuild if needed, Open-RMF + adapter | `[<id>] registered with RMF at (x, y)` |
| `events` | live log of every command the adapter sends | — |
| `ui` | demo console (http://localhost:8080) + RViz markers + RViz | `m20 ui: http://localhost:8080` |
| `mission` | `m20 mission-host`: runs the missions the GUI starts, printing every step. **Ctrl-C here aborts the mission and stops its robots** (standing), the fallback when the GUI is not usable; Ctrl-C when no mission runs quits it | `[host] mission host ready` |
| `operator` | shell for `m20 …` | prompt |

**Relays on their own:** `scripts/m20_stack.sh relay` starts only the robots' relays (own
tmux session `m20-relays`); a later `up` leaves them alone. No SSH by hand is needed:
the robots are powered off daily, so it starts the relay container if it is stopped,
recreates it from the robot's `~/docker-compose.yml` if it is gone, and installs the
relay DDS profile from `robot/fastdds_relay.xml` (with the robot's IP) only if the
container has none. Relays already running by hand? `M20_RELAY=none scripts/m20_stack.sh up`.
No RViz wanted? `M20_RVIZ=false`.

**Check in the operator pane before any motion:**
```bash
m20 status
```
Expect for each robot: `"registered": true`, `"pose_source": "odom"`, a sensible
`pose`, `"udp_link": true`. `"asleep": true` / `height` ≈ 0.08 means sitting — stand it
up with the controller first.

---

## 5. Demo console (GUI) and RViz

Open **http://localhost:8080** (or `http://<laptop ip>:8080` from a tablet on the Wi-Fi).
One screen, no scrolling: the **map** fills the window, the mission's phase and anything
waiting for the operator float over its top edge, and the robots, signals and log sit in
a sidebar on the right (below the map on narrow screens).

| Area | Shows / does |
|---|---|
| header | mission picker + **Start** (the `mission` pane runs it), **STOP ALL** |
| phase (over the map, top) | mission name, the current **phase**, elapsed time |
| action card (under the phase) | only when needed: the mission's question with its button (e.g. *Begin scenario*, *Suspicious item at box 1*), or an inspection waiting for a verdict (**Clear** / **Threat**) |
| map (the window) | the **RViz view** in the page: the SLAM map with the site (lanes, places, slots, tracks, targets) and each robot in its mode colour with its path. Scroll to zoom, drag to pan, double-click to fit the site again |
| robot cards (sidebar) | one per robot: **mode** (colour + word), one detail line (route, zone, target), battery; per-robot **Stop** when no mission is running |
| signal row | signals the mission offers at any time; pressing one early is fine, it shows **queued** until the mission uses it |
| log (sidebar) | phases, signals, verdicts, stops, inspections that ended without a verdict |

Modes (same colours in RViz): **PATROL** · **REGROUP** (forming up) · **EXPLORE** ·
**INVESTIGATE** (+ "awaiting verdict") · **RETURN** · **MOVE** · **HOLD** · **IDLE** ·
**SITTING** · **STOPPED** · **OFFLINE**. They come from the label of each robot's RMF task,
computed once by the status hub (`/m20/fleet_view`) for both GUI and RViz.

The page's map and **RViz** show the same thing: the hub forwards RViz's own `/m20/viz`
markers and `/m20/map` to the page. RViz is optional now (`M20_RVIZ=false
scripts/m20_stack.sh up` skips it). They draw, over the robot's **SLAM map**: the site's lanes
and places, formation slots, exploration tracks, targets, and each robot oriented in its
mode colour with its remaining path. The map is the site's saved map (`map:` in the site
file) or else the live relayed one. Save a map with `m20 map-save 834 <name>` (needs the
relay and bridge up), then add the printed `map:` line to the site file.

The GUI's buttons are the only way it moves robots: **Start** runs the chosen mission;
everything else stops, signals or answers. Start a mission only with someone by the robots.

**There is one kind of stop.** STOP ALL (and per-robot Stop, `m20 stop`, Ctrl-C in the
`mission` pane or in a terminal running `m20 mission`) always does the same thing: the
robots stop where they stand and **stay standing**, their RMF tasks are cancelled, and
the running mission **ends** — it never carries on to its next step (so a stop no longer
sends the robot home). The robots show **STOPPED** for 15 s, then IDLE; start a mission
again to continue. The mission's state reads *Mission stopped* with who stopped it.

If a mission's process dies (killed, crashed), the GUI shows **Mission lost** within a
few seconds instead of *running* forever: the robots may still be finishing their last
task, so press STOP ALL if needed. Start works again straight away.

**If the GUI itself fails** (page frozen, hub crashed): Ctrl-C in the tmux `mission`
pane — it stops the mission and its robots without the GUI. Then `m20 stop` in the
operator pane, or the controller. The page shows a red banner while it has no
connection to the hub.

## 6. Operate from the terminal

Always try one short step before a whole mission.

```bash
m20 go 834 fwd_2                  # to a place; ends at the place's heading
m20 go 834 fwd_1 --yaw 1.57       # ... with a different final heading
m20 action 834 turn_to '{"yaw": -1.57}'
m20 pose-goal 834 x y yaw         # off-graph pose
m20 patrol 834 --route corridor --rounds 1 --wait
m20 form-up line
m20 explore corridor_probe
m20 inspect box_right 834
m20 inspect-result latest '{"verdict": "empty"}'
m20 home
m20 mission /repo/rmf/m20_rmf/missions/test_834_corridor.yaml
m20 trigger start                 # releases a mission waiting on `event: start`
```
Every move is **turn in place → walk straight → turn in place**.

Information only: `m20 status`, `m20 pose 834`, `m20 events`, `m20 graph`,
`m20 --help`.

### Make your own route (site editing)
All from the operator pane, against the site in `m20_stack.yaml` (`--site` for another).
Each edit prints a diff, is checked (the site must load, missions must still validate)
and only then written; the file's comments stay. `--dry-run` shows the diff only.

```bash
m20 place ls                                  # places, their lanes, what uses them
# walk/drive 834 to a spot (controller or m20 go), then record it:
m20 place set bay_1 --from 834 --link fwd_2   # new place at 834's pose + lane to fwd_2
m20 place set bay_2 --from 834 --link bay_1   # ... and so on along the way
m20 route set loop fwd_2 bay_1 bay_2          # a patrol route through them
# the map in the GUI/RViz shows the change at once. For RMF to route on it (host):
scripts/m20_stack.sh restart rmf              # robots idle first
m20 go 834 bay_1                              # try each leg alone first
m20 patrol 834 --route loop --rounds 1 --wait
```

| Change | Command |
|---|---|
| move a place | `m20 place set bay_1 --from 834` or `m20 place set bay_1 x y [yaw]` (yaw in rad; omitted = keep) |
| remove a place | `m20 place rm bay_1` — removes its lanes too; refused while a route, formation, zone, target or robot home uses it (it says which) |
| connect / disconnect | `m20 lane add a b [c …]` (two-way chain) · `m20 lane rm a b` |
| routes | `m20 route set loop a b c` (create or replace) · `m20 route rm loop` |
| a robot's own patrol | `robots: "834": {…, route: loop}` in the site file (by hand) |

A place must have at least one lane (RMF could not reach it otherwise), and no edit may
leave another place without one. Formations, zones and targets are still edited by hand
in the site file (`sites/lab_834_corridor.yaml` is a small annotated example).
`scripts/m20_stack.sh restart <pane>` restarts any pane the same way (Ctrl-C, then
its command again), e.g. `restart ui`, `restart "relay 834"`.

### The corridor test (`missions/test_834_corridor.yaml`)
A one-robot rehearsal of the demo's shape (patrol → form up → explore → inspect → form
up → home) that never leaves a straight 2 m corridor in front of 834's start pose. Site
`sites/lab_834_corridor.yaml`: three places on one line, `home_834` (start), `fwd_1`
(1 m ahead), `fwd_2` (2 m ahead), all facing along the corridor. Needs ~2.5 m clear ahead.

| # | Step | What 834 does | GUI mode |
|---|---|---|---|
| 1 | `patrol` route `corridor` = [fwd_2, home_834], 1 round | walks 2 m out to fwd_2, turns round, walks back to home (ends facing back down the corridor) | PATROL |
| 2 | `form_up line` (one slot: fwd_1) | turns, walks 1 m to fwd_1, turns to face along the corridor | REGROUP |
| 3 | `explore corridor_probe` | from fwd_1 walks to 1.5 m, pauses 2 s, on to fwd_2 (2 m), turns to face back, pauses 2 s | EXPLORE |
| 4 | `inspect box_right` (approach fwd_2) | turns ~90° in place to look at a point 1 m to its right, holds 3 s, then waits up to 15 s for a verdict (GUI: Clear / Threat) | INVESTIGATE |
| 5 | `form_up line` | back 1 m to fwd_1, facing along the corridor | REGROUP |
| 6 | `return_home` | back 1 m to home_834, ending at its start heading | RETURN |

Each walk is turn in place → straight line → turn in place, so the robot never cuts a
corner. A STOP at any step ends the whole run (older builds went on to step 6, which is
why a stop used to send it home).

### Stopping — none of these drops the robot
1. **STOP ALL** in the GUI, or **Ctrl-C** in the `mission` pane (GUI missions) or in the
   terminal running `m20 go …` / `m20 mission …`.
2. **`m20 stop 834`** (or `m20 stop` for all) from any Jazzy terminal.
3. **`ros2 run nav_cmd_bridge nav_cmd_bridge cancel --ip <robot ip>`** from the Foxy
   devcontainer — works with RMF down.
4. **The handheld controller.**

1 and 2 also end whatever mission is running (§5).

Stopping the RMF launch does **not** stop a robot (it keeps its last goal) — cancel it.
`m20 estop --drop <id>` is the vendor e-stop and **drops the robot to the ground**.

---

## 7. Stop the stack
```bash
scripts/m20_stack.sh down        # Ctrl-C to every pane (relays too), then closes the sessions
```
Robots keep standing; sit them with the controller.

---

## 8. Build a demo

Files:

| File | Holds | After editing |
|---|---|---|
| `m20_stack.yaml` | active robots, domains, profile, which site | restart the stack |
| `rmf/m20_rmf/sites/<name>.yaml` | places, lanes, routes, formations, zones, targets, robots | restart the `rmf` pane |
| `rmf/m20_rmf/missions/<name>.yaml` | the script | nothing |

Start from `sites/sim_lab.yaml` (fully commented) or `sites/lab_834_corridor.yaml`.

1. **Record spots:** drive the robot there with the controller, then
   `m20 place set <name> --from 834 --link <neighbour>` (§6, *Make your own route*).
2. **Connect them with `lanes`** (`m20 lane add`; two-way chains, `oneway: true` by
   hand). RMF only routes along lanes.
3. **`m20 graph`** — validates and warns about places closer than footprint + vicinity
   (1.1 m): formation slots and homes must be further apart.
4. **Write the mission**, then `m20 mission <file> --check`.
5. **Rehearse on mock robots** (never real ones):
   ```bash
   export ROS_DOMAIN_ID=42
   ros2 launch m20_rmf m20_rmf.launch.py site:=/repo/rmf/m20_rmf/sites/<site>.yaml sim:=true
   m20 --site /repo/rmf/m20_rmf/sites/<site>.yaml mission /repo/rmf/m20_rmf/missions/<file>.yaml
   ```
   (mock robots need `ip: 127.0.0.1` and distinct `port`s — see `sim_lab.yaml`.)
6. **On the robot:** single steps, then the mission, from the operator pane.

Building blocks (runnable examples in `missions/examples.yaml`, full scenario in
`missions/visitor_demo.yaml`):

| Want | Site | Mission step |
|---|---|---|
| route along lanes | places, lanes | `go_to: {robot, place, yaw}` |
| loop a route | `routes` | `patrol: {robots, route, rounds, wait}` |
| any path shape | — | `action: {robot, category: waypoints, description: {poses, dwell, loops}}` |
| form up | `formations` | `form_up: {formation}` |
| sweep an area | `zones` (tracks) | `explore: {zone}` |
| inspect | `targets` | `inspect: {target, robot}` |
| turn / wait | — | `turn_to`, `hold` |
| flow | — | `parallel`, `repeat`, `wait_trigger`, `sleep`, `log`, `signal` |
| what the GUI shows big | — | `phase: "Exploring the new area"` |
| operator moments | mission header `signals: [{event, label, data}]` | `wait_trigger: {event, label, prompt}`; later steps can use the signal's data as `${event.key}` |

New behaviours are code: robot-side actions in `rmf/m20_rmf/m20_rmf/actions.py`,
mission steps in `primitives.py` (both documented at the top).

---

## 9. Without the launcher (manual)

```bash
# robot relay (laptop terminal)
ssh -t user@192.168.123.102 'docker exec -it user-nav_cmd_bridge-1 bash'
source /root/ros2_ws/install/setup.bash
export ROBOT_ID=834 ROS_DOMAIN_ID=0 FASTRTPS_DEFAULT_PROFILES_FILE=/root/fastdds_relay.xml
ros2 run nav_cmd_bridge odom_relay --ros-args -r __node:=odom_relay_834 \
  -p input_topic:=/ODOM -p output_topic:=/ODOM_relayed_834 -p frame_prefix:="'834'"

# Foxy devcontainer
source /root/ros2_ws/install/setup.bash
ros2 launch nav_cmd_bridge laptop_bridge.launch.py

# Jazzy devcontainer (three terminals)
ros2 launch m20_rmf m20_rmf.launch.py
m20 events
m20 status
```

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No `_<id>` topics on the laptop | relay profile missing / not pinning the Wi-Fi address | §2.3 profile |
| Topics but no `/ODOM` data | profile lacks `10.21.31.103` (localizer hosts) | §2.3 profile |
| Relays die: `Deserialization of data failed` → `bad_alloc` | a Jazzy process without `rmf/fastdds_jazzy.xml` reached them | keep Jazzy on domain 20 with that profile; never Jazzy on domain 0 |
| `Failed to create segment … SHM Transport is not supported` | `/dev/shm` full of stale segments | `python3 scripts/shm_clean.py` (Foxy devcontainer); stop nodes with Ctrl-C, not `kill -9` |
| `RMF refused to add robot … nearest place … m away` | robot too far from the nav graph | move it near a place, or add places/lanes |
| `m20 go` does nothing | robot already at that place (within 0.5 m) | normal |
| `m20 status` shows `pose_source: udp` | relayed odometry not arriving | check the relay and bridge panes |
| `no response to robot_task_request for robot X` | the running adapter doesn't serve X | add X to `robots:` / the launch |
| Robot won't walk, `asleep: true` | sitting | stand it up with the controller |
| Robot ping 0.1–1.6 s, SSH resets | full relay set loading its Wi-Fi | `robot_relay: odom` |
| `localized: false` while RViz looks right | the UDP `Location` flag's meaning is unconfirmed | trust RViz for now |
| RViz: `could not connect to display` / "Authorization required" | X access for root containers lost after reboot | `xhost +SI:localuser:root` (the launcher does it on `up`) |
| GUI page loads but stays empty | the `ui` pane is not running (or port 8080 taken) | check the `ui` pane; `pkill -f lib/m20_rmf/ui` in the Jazzy container |
| RViz has no map | robot relay without the map (`robot_relay: odom` includes it) or no `map:` in the site | `m20 map-save …` and add `map:` |
| `relay <id>` pane: container not running | robot powered off and back on | the relay command now starts / recreates it; rerun `scripts/m20_stack.sh relay` |
| GUI: *no mission host* on Start | the `mission` pane is not running | restart it: `m20 mission-host` in that pane (Jazzy container) |
| `[host] another mission host is running` | two hosts would both run each mission | use the one already running, or Ctrl-C it first |
| GUI: *Mission lost* | the mission's process died | STOP ALL if robots are still moving; start again |
| GUI: red *No connection* banner | the `ui` pane (hub) stopped | stop from the `mission` pane (Ctrl-C) or `m20 stop`; restart the `ui` pane |
| `relay <id>` pane: *ended (exit 255 …) Reconnecting* | Wi-Fi drop or robot rebooting | nothing: it reconnects by itself; Ctrl-C to give up |
| 3-robot site runs with one robot | CLI/launch robots default to `m20_stack.yaml` only with its own site | pass `--robots` / `robots:=` |

---

## 11. Reference

| Item | Value |
|---|---|
| Domains | robots/relays 0 · Open-RMF + tools 20 · mock rehearsal 42 |
| Vendor UDP | robot `:30000`, JSON over a 16-byte header (`protocol.py`) |
| Task-state websocket | `ws://localhost:7878` (monitor) |
| ROS topics | `/m20/events`, `/m20/robot_status`, `/m20/task_states`, `/m20/mission`, `/m20/mission_cmd`, `/m20/mission_host`, `/m20/fleet_view`, `/m20/viz`, `/m20/map`, `/m20/stop`, `/m20/trigger`, `/m20/inspect/request`, `/m20/inspect/result` |
| Demo console | http://localhost:8080 (websocket :8081) |
| Tests | `cd /repo/rmf/m20_rmf && python3 -m pytest -q test` (Jazzy devcontainer) |
| Robot container | `user-nav_cmd_bridge-1`, workspace `/root/ros2_ws` |
