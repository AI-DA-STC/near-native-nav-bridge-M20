# Command Center GUI

The operator console runs on this workstation and opens in a browser at http://localhost:5173. It opens on a landing page; **Launch** takes you through three steps:

1. **Setup.** You add the robots one at a time, and each one is brought up with its own commands: the README's for an M20, `start_aloha.sh` for the Mobile ALOHA.
2. **Routes.** You pick the mission plan's routes, or record new ones robot by robot for the robots you added, the way `demo/record_waypoints.sh` does, watching them in RViz on the map.
3. **Command center.** The mission screen, live: the robots you set up, the plan in use, and `demo/run_demo.sh` when you start it. It opens once Setup and Routes are both confirmed.

**Terminals** shows every terminal the GUI opened, live, at any time. **Fleet health** shows the link to each robot and the router, also at any time.

## Before the first run

Do these once:

1. Open the package in its devcontainer, which comes with Node 24.
2. Install the GUI's packages:
   ```bash
   cd frontend
   npm install
   ```
3. Make sure the robots and this workstation are on the router "near-robots-5G", with the static IPs from README.md.
4. Make sure this workstation's registry (192.168.123.160:5000) serves `m20-bridge:foxy`.
5. For the ALOHA: `start_aloha.sh`, `dock.py` and `stream.launch` from `aloha/robot/` are in the ALOHA's home folder.

## Start it

```bash
cd frontend
npm run dev
```

Then open http://localhost:5173 and click **Launch**.

To stop it, press Ctrl+C in that terminal. The GUI then stops the relays it started on the dogs and the ALOHA's bridge, closes RViz, and closes its terminals. The ALOHA's own stack keeps running in its tmux session, as `start_aloha.sh` intends.

## 1. Set up the robots

1. **Add a robot.** Setup lists the README's robots and shows which ones answer. Click **Add 741**, or fill in the form:
   - the robot ID;
   - the login, as `user@<ip>` (`user` on an M20, `agilex` on the ALOHA);
   - the password.

   An empty password means the default: `'` for an M20 (the README's), `agx` for the ALOHA (`start_aloha.sh`'s). Passwords are kept in `frontend/server/robots.json` on this workstation, which is not in git and is readable by you only. They are never sent back to the browser.
2. **Watch the steps.** A robot that answers starts its setup at once. Each command is typed into a terminal on this workstation, exactly as written.

   An M20, from README.md:

   | | Step | Typed |
   |---|---|---|
   | | Log in | `ssh user@<ip>` and `su`, with its password |
   | a | Pull image | `docker pull …` and `docker tag …` |
   | b | Start relay | `docker compose up -d nav_cmd_bridge`, `docker compose exec nav_cmd_bridge bash`, the two exports, then `ros2 launch nav_cmd_bridge relays.launch.py` |
   | c | Laptop | `export ROS_DOMAIN_ID=0`, `export FASTRTPS_DEFAULT_PROFILES_FILE=fastdds_profile.xml`, `source install/setup.bash` |
   | d | Check topics | `ros2 topic list` (the robot's `_<id>` topics and the shared TF), then `ros2 topic hz /ODOM_relayed_<id>` |
   | e | Localize | `rviz2 -d frontend/server/rviz/robot_<id>.rviz --ros-args …`: README.md's laptop side Step 5, plus `-d`, so RViz opens on the robot's own map, odometry and waypoints |
   | f | Nav bridge | The exports, `export ROBOT_ID=<id>`, then `ros2 run nav_cmd_bridge nav_cmd_bridge bridge --ip <ip>` (README Multi-robot Step 1) in its own terminal: the bridge the mission's goals reach the robot through. It moves nothing by itself, only a heartbeat until a goal arrives. A bridge already listening on `/goal_pose_<id>` is kept |

   The Mobile ALOHA:

   | | Step | Typed |
   |---|---|---|
   | | Log in | `ssh agilex@192.168.123.200`, with its password |
   | a | Start ALOHA | `bash start_aloha.sh`: roscore, the cameras, the Piper arms, the lidar, the base, navigation, `stream.launch` and `dock.py`, each in a window of the tmux session `aloha` |
   | b | Check its stack | nothing typed: each of the eight is checked on the ALOHA's ROS master, by the topics it publishes |
   | c | Bridge | `export FASTRTPS_DEFAULT_PROFILES_FILE=fastdds_profile.xml`, then `aloha/bridge.sh` on this workstation: the ALOHA's topics on ROS_DOMAIN_ID=1, with `/scan`'s rate checked |
   | d | Localize | in a terminal of its own (**Laptop · RViz**): the exports, `source install/setup.bash`, then `ROS_DOMAIN_ID=1 rviz2 -d frontend/server/rviz/aloha.rviz`. Set its **2D Pose Estimate** on its own map; it goes to `/initialpose`, which the bridge passes to AMCL on the robot. The step shows your estimate and AMCL's pose after it, then you confirm |

   The ALOHA is localized on its own map, not the dogs': the two are not aligned. Without it, AMCL starts wherever its parameters put it, often in unknown space, and `move_base` finds no plan (`Failed to get a plan`, `Rotate recovery can't rotate in place … Cost: -1.00`). The localize window has no 2D Goal Pose: there it would drive the ALOHA.
3. **Answer when asked.** A step that needs you turns blue, and the header says WAITING FOR YOU.
   - **The robot refused the password:** type it in the step and click **Log in again**. It replaces the saved one.
   - **The robot's Docker doesn't trust the registry:** add the registry to `/etc/docker/daemon.json` on the robot and restart Docker. **Open the robot terminal** takes you to the robot's terminal under Terminals, which is already root on the robot. Then come back to Setup and click **Retry pull**.
   - **A relay is already running:** click **Restart the container**, or **Keep it**.
   - **`start_aloha.sh` is already running:** click **Keep it**, or **Restart it** (`bash start_aloha.sh stop`, then start).
   - **Localize:** in the RViz window named `robot_<id>.rviz`, use **2D Pose Estimate** where the robot stands, then click **\<id\> is localized**.
4. **Go on.** When the GUI says "\<id\> is ready", click **Add the next robot**. When every robot in the lobby is ready, click **Continue to Routes**: that confirms Setup. Remove a robot you won't use first.

The robots you add are remembered in `frontend/server/robots.json`. Next time they are back in their seats, faded and marked OFFLINE if they don't answer.

## 2. Routes

Routes are recorded for the robots added in Setup, the ALOHA included. Each mission plan is a folder of `demo/waypoints` named after when its recording session started, like `2026-11-20_15-02-10`. It holds the six files `demo/run_demo.sh` needs: `patrol`, `formation`, `sweep`, `cordon`, `aloha` and `manipulator.json`. `demo/waypoints/current` points at the plan in use; `run_demo.sh`, `record_waypoints.sh` and the ALOHA scripts read it by default.

| Phase | Who takes part |
|---|---|
| Patrol, Formation, Sweep | every dog added |
| Cordon | every dog added: R1 and R2 cordon the box, R3's waypoint is where it watches it from |
| ALOHA to the box (`aloha.json`) | the ALOHA: its route, in order; it docks onto the last waypoint, at the box |

- **Pick a plan.** The plans are listed newest first, and the latest is selected. The sketches on the right show its routes in map-frame metres, without the map; RViz shows them on the map while you record. Each plan shows whether each phase is complete for the robots added, and what it re-recorded. A plan that names a robot you did not add is flagged: `run_demo.sh` would wait for that robot.
- **Use this plan** points `current` at it and confirms Routes. You then go on to the Command center, or back to Setup if Setup isn't confirmed yet.
- **Record new routes from it** starts a session: a new dated folder, a copy of the selected plan with only the robots added (the plan's other robots are left out, and the plan says "without 665"). The grid has a column per robot added. For a robot and a phase, **Record** opens its RViz, then types the README's command into the Routes terminal:
  ```bash
  ONLY="741" WAYPOINTS=demo/waypoints/<session> demo/record_waypoints.sh sweep
  ONLY="aloha" WAYPOINTS=demo/waypoints/<session> demo/record_waypoints.sh aloha
  ```
  with `APPEND=1` when you tick **Add after its waypoints**. Then drive the robot with its controller:

  | Button | Key it sends | |
  |---|---|---|
  | **Record waypoint** | ENTER | Records the robot's pose: `/ODOM_relayed_<id>` for a dog, `/amcl_pose` for the ALOHA |
  | **Undo** | `u` | Drops its last waypoint |
  | **Clear** | `c` | Drops them all |
  | **Save** | `w` | Writes the phase file; the other robots' routes in it are kept |
  | **Cancel** | Ctrl+C | Quits without saving |

  **Finish session** keeps the new plan, which becomes the latest. **Discard** deletes its folder.
- **RViz while recording.** The dogs' RViz (ROS_DOMAIN_ID=0) shows their map, each dog's odometry and `/fleet_goal_markers`. It is the README's Multi-robot Step 2 command with `-d frontend/server/rviz/routes.rviz`. The ALOHA's RViz (ROS_DOMAIN_ID=1) shows its own map, its AMCL pose and its route.
  - The robot being recorded is drawn bright and the phase's other routes dimmed, each robot in its own colour: its place in the phase's file, as `run_demo.sh` draws it too.
  - A **2D Goal Pose** arrow drawn in RViz goes to `/fleet_goal`. It is recorded as the robot's next waypoint, like Record waypoint, and never moves a robot.
  - The list on the right shows every waypoint as RViz labels it (`741·3`), in the same colour, with where the robot is now.
  - RViz stays open for the session; **Open RViz again** reopens it after you close it.

The ALOHA's arm poses (`manipulator.json`) are carried over from plan to plan; they are not recorded here. The ALOHA's route is on its own map, not yet aligned with the dogs'.

## 3. The Command center

Its tab stays locked until Setup and Routes are both confirmed. After a restart of the GUI you confirm them again.

- **Robots.** R1, R2 and R3 are the dogs you added, by their IDs (741, 665, 738); a dog with another ID takes a free role. A robot is in the mission when it is added and in the plan in use; the others are left out. **Fleet** counts the dogs whose nav bridge listens, **Positions** those whose `/ODOM_relayed_<id>` is fresh (3 s). The ALOHA's pose comes from its `/amcl_pose`, drawn on its own map in the ALOHA tab.
- **Map.** The dogs' SLAM map, read once from `/GRID_MAP_relayed_<id>` of a dog that is set up (`frontend/server/map_grid.py`), under the plan's routes for the phase under way, and the dogs' positions and trails. The box (`demo/box.json`) appears only once R3 has found it.
- **Map tabs.** **Dogs** is the dogs' SLAM map with R1–R3, their routes and the box. **ALOHA** is the ALOHA's own map (`/map` through its bridge, ROS_DOMAIN_ID=1) with its position (`/amcl_pose`), its route to the box (`aloha.json`) and its dock pose. The two maps are not aligned, so each has its tab; the ALOHA tab shows only while the ALOHA is in the mission. Each map is read once (`frontend/server/map_grid.py`), cropped to its known part: the ALOHA's 4000 x 4000 map becomes the few dozen metres it covers. Until the ALOHA's map is in, its tab says why: its bridge not running, being read, or what the read found (e.g. `no map on /map within 40 s`); it tries again every 30 s, and the server's console says the same.
- **Layout.** The phases across the top, the cameras under them over the map, and Operator, Suspicious item and History on the right. The chevron at the phases' top left, and the one by **Cameras**, minimize each to one line; this browser remembers your choice.
- **Cameras.** Side by side over the map, one frame a second from each robot in the mission, with the robot's state word (SWEEPING, IN SLOT, NOT CONNECTED …): every dog's front camera (`/camera_front_relayed_<id>`, from `scripts/camera_relay.py` on the dog, started with its relays) and the ALOHA's centre camera (`/camera_f/color/image_throttled/compressed` through its bridge). `frontend/server/camera_frames.py` keeps the latest frame of each. A tile says when its feed has stopped, or that it never had one. Click a tile to enlarge it; it keeps updating.
- **Start mission** is enabled once nothing blocks it (each blocker says what to fix). It runs, in the **Mission** terminal under Terminals:
  ```bash
  WAYPOINTS=demo/waypoints/<plan> R3=<R3's id> DETECT=fixed demo/run_demo.sh
  ```
  `DETECT=fixed`: once R3 stops within 2 m of the box during the sweep, `demo/find_box.py` reports it with R3's photo. A notification says **Anomalous object identified**, the box appears on the map, and Suspicious item shows R3's photo with where the box is. The page follows the script's output: phases, the plan to approve or deny, each robot's waypoints, docking, the arms, the contents photo, your verdict. Your answers are typed into it as you would type them.
- **Stop** is Ctrl+C: no new waypoints, each robot finishes the one it drives to, the ALOHA's arms freeze. **Force stop** closes the Mission terminal.
- **E-STOP** sends each dog in the mission `nav_cmd_bridge estop --ip <ip>` (confirmed when the robot replies within 3 s), cancels the ALOHA's `move_base` (`/move_base/cancel`), and ends the run. The ALOHA's docking and arms have no remote stop: ending the run freezes the arms.

## Terminals

Setup shows only each step's status. **Open in Terminals**, at the top of a robot's setup, goes to the terminal its current step types into:

- **Robot · relay** is `ssh` to an M20, then `su`, then the container running `relays.launch.py`.
- **Robot · tmux** is `ssh` to the ALOHA, attached to `start_aloha.sh`'s tmux session when the setup started it (after **Keep it**, type `tmux attach -t aloha`): Ctrl+b then n or p switches windows, Ctrl+b then d detaches.
- **Laptop** has the exports, the topic checks and `rviz2`; for the ALOHA, its bridge, and **Laptop · RViz** the RViz it is localized in.
- **Laptop · nav bridge** is an M20's nav bridge (step f).
- **Routes · Recorder** is where `demo/record_waypoints.sh` runs; **Routes · RViz dogs** and **Routes · RViz ALOHA** hold the RViz windows recording draws in.
- **Mission** is where Start mission runs `demo/run_demo.sh`.
- **Network · ping**, under each robot and under Router, is that robot's Fleet health dashboard.

They are live: what you type goes to the terminal in front, and **Ctrl+C** interrupts it.

## Fleet health

One terminal per robot added in Setup, plus one for the router (this laptop's default gateway, 192.168.123.1), three to a row. Each runs `frontend/server/net_dash.py`, which pings its host once a second from the laptop (no `ping` binary needed) and shows:

- **UP**, **SLOW**, **LOSING PINGS**, or **DOWN** after three pings in a row get no reply, and the latest round-trip time.
- min, mean, max, jitter and loss over the last 10 s, 60 s and 5 min, and since it started. A narrow pane shows one period, and **p** switches it.
- A chart of the latest pings: green up to 30 ms, amber up to 100 ms, red above, and × for a lost ping.

Click a terminal to type into it: **r** restarts the totals, **q** quits to its shell (↑ then Enter runs it again). The GUI starts them when it starts, follows the robots you add or remove, and reopens one you `exit` within 30 s. If a robot is slow or down while the router is fine, the problem is that robot's link, not the Wi-Fi.

## Good to know

- **What a robot's RViz shows** comes from `frontend/server/robot.rviz`, with `ROBOT_ID` replaced by the robot's ID, freshly for each setup. Edit that file to change the displays or the starting view for every robot. Your own `~/.rviz2/default.rviz` is not touched.
- **Only this workstation can open the GUI.** It hands out shells on the robots. `HOST=0.0.0.0 npm run dev` opens it to the network, and then anyone who can reach the port gets those shells.
- **Another port:** `PORT=5174 npm run dev`.
- **Opening the Command center without confirming Setup and Routes:** `MISSION_UNLOCKED=1 npm run dev`. It shows the robots as they are, on `demo/waypoints/current`.
- **Another mission script, to rehearse the page without robots:** `MISSION_SCRIPT=path/to/fake.sh npm run dev`, relative to the package root.
- **The plans somewhere else:** `PLANS_DIR=/some/folder npm run dev`.
- **Removing the ALOHA** stops its bridge and runs `bash start_aloha.sh stop` on it, which stops its arms, base and navigation.
- **If the GUI was killed rather than stopped with Ctrl+C,** a relay can keep running on a robot. The next setup of that robot finds it and offers to restart the container.
