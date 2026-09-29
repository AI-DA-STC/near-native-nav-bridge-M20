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
1. **Wi-Fi:** the robot joins `near-robots-5G` (p2p0) at its fixed `.10x` address.
   Robots also carry an old `near-robots-2.4G` profile (`192.168.8.x`); give the 5G one a
   higher priority so a reboot never picks 2.4G (then the robot vanishes from `.10x`):
   `sudo nmcli connection modify near-robots-5G connection.autoconnect-priority 10`.
2. **SSH key** so the launcher can start the relay:
   `ssh-copy-id -i ~/.ssh/id_m20.pub user@<ip>` (SETUP §6).
3. **Docker without sudo** for that user (the launcher runs `docker` over SSH): `id`
   must list `docker`; if not, once: `sudo usermod -aG docker user`.
4. **Relay DDS profile:** nothing to do. The launcher copies `robot/fastdds_relay.xml`
   (with the robot's IP) into the relay container as `/root/m20_relay_profile.xml` on
   every start and runs the relays with it. It lists the Wi-Fi address *and*
   `10.21.31.103`, `10.21.32.103`, `10.21.33.103` with SHM on; without them the laptop
   sees no topics or no `/ODOM`. The team's own `~/fastdds_relay.xml` on the robots
   (mounted read-only into the container, without `10.21.31.103`) is not used.
5. Add the robot to the site file (`robots:` with `ip`, `home`, optional `route`) and to
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
display (for RViz) and opens RViz and the operator dashboard (§5).

| Pane | What it is | Healthy when |
|---|---|---|
| `relay <id>` | SSH → robot → relay container → odometry + SLAM-map relays. Stays in SSH showing the relay output; if the link drops or the relay ends, it says why and reconnects every 5 s (clearing any relay left behind). Ctrl-C stops it for good | `Relay: /GRID_MAP -> …` and `Relay: /ODOM -> /ODOM_relayed_<id>` |
| `bridge` | Foxy: rebuild if needed, `shm_clean`, laptop bridge | `robots [...], domain 0 -> 20 ...`, then `Relay:` lines (2 shared + 4 per robot) |
| `rmf` | Jazzy: rebuild if needed, Open-RMF + adapter | `[<id>] registered with RMF at (x, y)` |
| `events` | live log of every command the adapter sends | — |
| `ui` | the operator dashboard (http://localhost:8080) and its hub, RViz markers, RViz | `m20 ui: http://localhost:8080` |
| `rmf-api` | Open-RMF's rmf-web API server (:8000, docker image), read by the dashboard's map / robots / tasks panels | its log ends with `started app` |
| `mission` | `m20 mission-host`: runs the missions the GUI starts, printing every step. **Ctrl-C here aborts the mission and stops its robots** (standing), the fallback when the GUI is not usable; Ctrl-C when no mission runs quits it | `[host] mission host ready` |
| `operator` | shell for `m20 …` | prompt |

**Relays on their own:** `scripts/m20_stack.sh relay` starts only the robots' relays (own
tmux session `m20-relays`); a later `up` leaves them alone. No SSH by hand is needed:
the robots are powered off daily, so it starts the relay container if it is stopped,
recreates it from the robot's `~/docker-compose.yml` if it is gone, and copies in our
relay DDS profile (`robot/fastdds_relay.xml` with the robot's IP, §2.3). Relays already running by hand? `M20_RELAY=none scripts/m20_stack.sh up`.
No RViz wanted? `M20_RVIZ=false`.

**Check in the operator pane before any motion:**
```bash
m20 status
```
Expect for each robot: `"registered": true`, `"pose_source": "odom"`, a sensible
`pose`, `"udp_link": true`. `"asleep": true` / `height` ≈ 0.08 means sitting — stand it
up with the controller first.

---

## 5. The operator dashboard (GUI) and RViz

Open **http://localhost:8080** (or `http://<laptop ip>:8080` from a tablet on the Wi-Fi).
It is **Open-RMF's own dashboard** (`rmf-dashboard-framework`, the one rmf-web ships)
with our mission panels added to it: one page for the fleet as Open-RMF sees it and for
the mission. The red **STOP ALL** button (bottom right) is on every tab.

| Tab | Panels |
|---|---|
| **Operations** | **Mission** (ours): mission name, the current **phase**, elapsed time; the mission picker + **Start** when none runs; the mission's question with its button when it waits (e.g. *Explore the area*); an inspection's **Clear / Threat**; signal buttons (pressing one early is fine: *queued*); the log. **Fleet** (ours): one card per robot, its **mode** in colour, one detail line, battery; per-robot **Stop** when no mission runs. **Map** (Open-RMF's) |
| **Robots** | Open-RMF's robot table (status, battery, level, task), our Fleet cards, the map |
| **Tasks** | Open-RMF's task queue and history (every task missions and `m20` commands create; click one for its log), the map |
| **Custom** | arrange any of these panels yourself (kept in this browser) |

**New task** (top bar) is Open-RMF's form for a single task: a patrol through chosen
places, or a raw composed task. It moves robots like Start does.

**The map** (Open-RMF's) draws the site's saved SLAM map, cut to the site, with the site
drawn on it in the mode colours (lanes, formation slots, zones with their sweep, targets),
and Open-RMF's places with their names and the robots. Scroll / buttons to zoom, drag to
pan. It is fed by `viz`, which publishes the site as an Open-RMF `BuildingMap` on `/map`
and redraws it when the site file changes.

Modes: **PATROL** · **REGROUP** (forming up) · **EXPLORE** · **INVESTIGATE** (+ "awaiting
verdict") · **RETURN** · **MOVE** · **HOLD** · **IDLE** · **SITTING** · **STOPPED** ·
**OFFLINE**, from the label of each robot's RMF task (the hub's `/m20/fleet_view`).

**How it is put together:** Open-RMF's panels read the **rmf-web API server** (tmux pane
`rmf-api`, docker image, :8000), which our task monitor forwards every RMF update to; our
panels read the hub (the `ui` pane, which also serves the page). The page is built once
per laptop into `rmf/m20_rmf/dashboard/dist` with `scripts/m20_stack.sh dashboard` (the
`web` devcontainer; needs internet the first time); until then :8080 shows the older
standalone console. Sources: `rmf/m20_rmf/dashboard/src/` (main.tsx: tabs and layout;
mission-panel.tsx, fleet-panel.tsx: our panels; hub.ts: the hub connection).

**RViz** (optional, `M20_RVIZ=false` skips it) shows the same site over the live or saved
SLAM map, with each robot in its mode colour and its remaining path (`/m20/viz`,
`/m20/map`). Save a map with `M20_RELAY=odom+map` relays running and
`m20 map-save 834 <name>`, then add the printed `map:` line to the site file.

The dashboard moves robots only through **Start** and **New task**; everything else
stops, signals or answers. Start a mission only with someone by the robots.

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
operator pane, or the controller. The Mission panel shows a red message while it has
no connection to the hub.

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
Relative paths given to any `m20` command (or `site:=` of the launch files) are relative
to the repo root, like the paths in `m20_stack.yaml`, from whatever directory you are in.
Each edit prints a diff, is checked (the site must load, missions must still validate)
and only then written; the file's comments stay. `--dry-run` shows the diff only.

```bash
m20 site new rmf/m20_rmf/sites/lab_b.yaml --from 834   # only for a new site: 834 + its
#   home at its current pose; then site: in m20_stack.yaml, scripts/m20_stack.sh down + up
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
| exploration area | `m20 zone corner area_b --from 834 --entry gate` (first corner), then `m20 zone corner area_b --from 834` at each further corner · `m20 zone corner area_b --place corner_1` uses an existing place (by name: the corner follows the place) · `m20 zone set area_b --exit gate_2 --spacing 1.0 --margin 0.4` · `m20 zone clear` / `rm` |
| a robot's own patrol | `robots: "834": {…, route: loop}` in the site file (by hand) |

A place must have at least one lane (RMF could not reach it otherwise), and no edit may
leave another place without one. Formations, zones and targets are still edited by hand
in the site file (`sites/lab_834_corridor.yaml` is a small annotated example).
`scripts/m20_stack.sh restart <pane>` restarts any pane the same way (Ctrl-C, then
its command again), e.g. `restart ui`, `restart "relay 834"`.

### Exploring an area (zones with a boundary)
Walk the robot to each corner of the area, in order around it (clockwise or not), and
record it with `m20 zone corner <zone> --from 834` (`--entry <place>` on the first). With
3+ corners the site turns the polygon into a **sweep**: straight rows `spacing` m apart
(default 1.0), `margin` m in from the edges (default 0.4), along the polygon's longest
edge (or `--angle`), walked back and forth. The GUI/RViz map draws the boundary and the
sweep as soon as each corner is added.

`explore: {zone: area_b, seconds: 120}` in a mission: the robot goes to the zone's
`entry` place (on the graph), sweeps, and ends at the zone's `exit` place (default: the
entry). With `seconds`, it stops where it is when time is up and walks to the exit; the
step then ends normally. The way out is announced to RMF's traffic schedule, so a
separate `exit` keeps robots coming back out of the way of robots going in.

The boundary is **where the sweep is planned, not a fence**: the robot's own navigation
walks between sweep points (avoiding obstacles its sensors see), and the walk from the
entry to the first row starts outside the area. Keep areas convex (a concave one is
swept only along the widest stretch of each row), and clear of walls by at least the
margin. Example: `missions/triangle_watch.yaml` (patrol, explore on request for 2 min,
patrol again, forever).

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
export ROBOT_ID=834 ROS_DOMAIN_ID=0 FASTRTPS_DEFAULT_PROFILES_FILE=/root/m20_relay_profile.xml
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
| Everything on the laptop stalls (even the internet) while relays run | the robots' traffic fills the laptop's one Wi-Fi link | `scripts/m20_stack.sh netcheck` shows by what; keep `robot_relay: odom` (odometry only, best effort); the live map only with `odom+map` when needed |
| `localized: false` while RViz looks right | the UDP `Location` flag's meaning is unconfirmed | trust RViz for now |
| RViz: `could not connect to display` / "Authorization required" | X access for root containers lost after reboot | `xhost +SI:localuser:root` (the launcher does it on `up`) |
| GUI page does not load | the `ui` pane is not running (or port 8080 taken) | check the `ui` pane; `scripts/m20_stack.sh restart ui` |
| Dashboard map / Robots / Tasks empty, Mission panel fine | the `rmf-api` pane is not running, or its image is missing | check that pane; `docker pull ghcr.io/open-rmf/rmf-web/api-server:jazzy-nightly` |
| :8080 shows the older dark console | the dashboard is not built on this laptop | `scripts/m20_stack.sh dashboard` (internet once), then reload |
| RViz has no map | robot relay without the map (`robot_relay: odom` includes it) or no `map:` in the site | `m20 map-save …` and add `map:` |
| `relay <id>` pane: container not running | robot powered off and back on | the relay command now starts / recreates it; rerun `scripts/m20_stack.sh relay` |
| GUI: *no mission host* on Start | the `mission` pane is not running | restart it: `m20 mission-host` in that pane (Jazzy container) |
| `[host] another mission host is running` | two hosts would both run each mission | use the one already running, or Ctrl-C it first |
| GUI: *Mission lost* | the mission's process died | STOP ALL if robots are still moving; start again |
| Mission panel: red *No connection to the M20 hub* | the `ui` pane (hub) stopped | stop from the `mission` pane (Ctrl-C) or `m20 stop`; restart the `ui` pane |
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
