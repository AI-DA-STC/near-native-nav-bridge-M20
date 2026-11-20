# Command Center GUI

The operator console runs on this workstation and opens in a browser at http://localhost:5173. It opens on a landing page; **Launch** takes you through three steps:

1. **Setup.** You add the robots one at a time, and each one is brought up with its own commands: the README's for an M20, `start_aloha.sh` for the Mobile ALOHA.
2. **Routes.** You pick the mission plan's routes, or record new ones robot by robot, the way `demo/record_waypoints.sh` does.
3. **Command center.** The mission screen. It opens once Setup and Routes are both confirmed, and still runs on demo data.

**Terminals** shows every terminal the GUI opened, live, at any time.

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

   The Mobile ALOHA:

   | | Step | Typed |
   |---|---|---|
   | | Log in | `ssh agilex@192.168.123.200`, with its password |
   | a | Start ALOHA | `bash start_aloha.sh`: roscore, the cameras, the Piper arms, the lidar, the base, navigation, `stream.launch` and `dock.py`, each in a window of the tmux session `aloha` |
   | b | Check its stack | nothing typed: each of the eight is checked on the ALOHA's ROS master, by the topics it publishes |
   | c | Bridge | `export FASTRTPS_DEFAULT_PROFILES_FILE=fastdds_profile.xml`, then `aloha/bridge.sh` on this workstation: the ALOHA's topics on ROS_DOMAIN_ID=1, with `/scan`'s rate checked |

   The ALOHA has no Localize step: its map is not aligned with the dogs' map yet.
3. **Answer when asked.** A step that needs you turns blue, and the header says WAITING FOR YOU.
   - **The robot refused the password:** type it in the step and click **Log in again**. It replaces the saved one.
   - **The robot's Docker doesn't trust the registry:** add the registry to `/etc/docker/daemon.json` on the robot and restart Docker. **Open the robot terminal** takes you to the robot's terminal under Terminals, which is already root on the robot. Then come back to Setup and click **Retry pull**.
   - **A relay is already running:** click **Restart the container**, or **Keep it**.
   - **`start_aloha.sh` is already running:** click **Keep it**, or **Restart it** (`bash start_aloha.sh stop`, then start).
   - **Localize:** in the RViz window named `robot_<id>.rviz`, use **2D Pose Estimate** where the robot stands, then click **\<id\> is localized**.
4. **Go on.** When the GUI says "\<id\> is ready", click **Add the next robot**. When every robot in the lobby is ready, click **Continue to Routes**: that confirms Setup. Remove a robot you won't use first.

The robots you add are remembered in `frontend/server/robots.json`. Next time they are back in their seats, faded and marked OFFLINE if they don't answer.

## 2. Routes

Each mission plan is a folder of `demo/waypoints` named after when its recording session started, like `2026-11-20_15-02-10`. It holds the six files `demo/run_demo.sh` needs: `patrol`, `formation`, `sweep`, `cordon`, `aloha` and `manipulator.json`. `demo/waypoints/current` points at the plan in use; `run_demo.sh`, `record_waypoints.sh` and the ALOHA scripts read it by default.

- **Pick a plan.** The plans are listed newest first, and the latest is selected. The preview on the right shows its four phases on the map frame, each robot's route in its colour. Each plan shows whether each phase is complete, by the README's table, and what it re-recorded.
- **Use this plan** points `current` at it and confirms Routes. You then go on to the Command center, or back to Setup if Setup isn't confirmed yet.
- **Record new routes from it** starts a session: a new dated folder, a copy of the selected plan. For each phase and robot, **Record** types the README's command into the Routes terminal:
  ```bash
  ONLY="741" WAYPOINTS=demo/waypoints/<session> demo/record_waypoints.sh sweep
  ```
  with `APPEND=1` when you tick **Add after its waypoints**. Then drive the robot with its controller:

  | Button | Key it sends | |
  |---|---|---|
  | **Record waypoint** | ENTER | Records the robot's pose from `/ODOM_relayed_<id>` |
  | **Undo** | `u` | Drops its last waypoint |
  | **Clear** | `c` | Drops them all |
  | **Save** | `w` | Writes the phase file; the other robots' routes in it are kept |
  | **Cancel** | Ctrl+C | Quits without saving |

  The preview follows the robot while you record. **Finish session** keeps the new plan, which becomes the latest. **Discard** deletes its folder.

The ALOHA's pose at the box (`aloha.json`) and its arm poses (`manipulator.json`) are carried over from plan to plan; they are not recorded here.

## 3. The Command center

Its tab, and Fleet health and Log, stay locked until Setup and Routes are both confirmed. After a restart of the GUI you confirm them again. E-STOP is on the Command center only: setting up moves no robot.

## Terminals

Setup shows only each step's status. **Open in Terminals**, at the top of a robot's setup, goes to the terminal its current step types into:

- **Robot · relay** is `ssh` to an M20, then `su`, then the container running `relays.launch.py`.
- **Robot · tmux** is `ssh` to the ALOHA, attached to `start_aloha.sh`'s tmux session when the setup started it (after **Keep it**, type `tmux attach -t aloha`): Ctrl+b then n or p switches windows, Ctrl+b then d detaches.
- **Laptop** has the exports, the topic checks and `rviz2`; for the ALOHA, its bridge.
- **Routes · Recorder** is where `demo/record_waypoints.sh` runs.

They are live: what you type goes to the terminal in front, and **Ctrl+C** interrupts it.

## Good to know

- **What a robot's RViz shows** comes from `frontend/server/robot.rviz`, with `ROBOT_ID` replaced by the robot's ID, freshly for each setup. Edit that file to change the displays or the starting view for every robot. Your own `~/.rviz2/default.rviz` is not touched.
- **Only this workstation can open the GUI.** It hands out shells on the robots. `HOST=0.0.0.0 npm run dev` opens it to the network, and then anyone who can reach the port gets those shells.
- **Another port:** `PORT=5174 npm run dev`.
- **Reviewing the Command center without robots:** `MISSION_UNLOCKED=1 npm run dev` opens it without Setup and Routes, on demo data.
- **The plans somewhere else:** `PLANS_DIR=/some/folder npm run dev`.
- **Removing the ALOHA** stops its bridge and runs `bash start_aloha.sh stop` on it, which stops its arms, base and navigation.
- **E-STOP and the Command center still run on demo data. E-STOP does not reach the robots.**
- **If the GUI was killed rather than stopped with Ctrl+C,** a relay can keep running on a robot. The next setup of that robot finds it and offers to restart the container.
