# nav_cmd_bridge

Navigation command bridge for DeepRobotics M20 Pro. Sends waypoints over UDP and subscribes to `/ODOM` for position tracking. Supports RViz2-driven navigation and structured benchmark testing (T1–T4).

# Docker build and push instructions from workstation (ignore for now)

The robot is arm64, the laptop is x86, so the image is cross-built on the laptop and pushed
through a plain-HTTP registry running on the laptop itself.

## One-time setup only

QEMU emulators (cross-building arm64 on x86; resets on reboot unless persisted):
```bash
docker run --privileged --rm tonistiigi/binfmt --install arm64
```

buildx builder (the default docker driver can't cross-build reliably):
```bash
docker buildx create --name multiarch --driver docker-container --use --bootstrap
```

A local image registry on the laptop (persists across reboots):
```bash
docker run -d --restart=always -p 5001:5000 --name demo_navigation_stack registry:2
```

## Build and push (on laptop)

```bash
docker buildx build --platform linux/arm64 -f Dockerfile.deploy -t m20-bridge:foxy --load .
docker tag  m20-bridge:foxy localhost:5000/m20-bridge:foxy   # localhost = auto-insecure, no config
docker push localhost:5000/m20-bridge:foxy                   # progress + only changed layers
```

# Docker pull instructions in robot

Connect to "near-robots-5G" and make sure to set a static ip for the robot as per the following: 

router gateway : 192.168.123.1
Main Workstation : 192.168.123.160
Robot 741 : 192.168.123.100
Robot 665 : 192.168.123.101
Robot 738 : 192.168.123.103

On **robot**, trust the laptop's plain-HTTP registry, then restart docker:
```bash
# /etc/docker/daemon.json   (<WS_IP> = laptop's address on the 10.21.31.x LAN)
{ "insecure-registries": ["192.168.123.160:5000"] }
sudo systemctl restart docker
```

```bash
docker pull --platform linux/arm64 192.168.123.160:5000/m20-bridge:foxy
docker tag  192.168.123.160:5000/m20-bridge:foxy m20-bridge:foxy     # restore the clean name
```

# Robot side setup

- Step 1 : Connect to the router WiFi "near-robots-5G" 
- Step 2 : SSH into the robot with its IP from the table above, password = ' (single quote)
```bash
ssh user@<robot_ip>
```
- Step 3 : Run the relay node to convert DeepRobotics topics to ROS topics 

```bash
su
docker compose up -d nav_cmd_bridge
docker compose exec nav_cmd_bridge bash
export ROBOT_ID=<robot_id>
export ROS_DOMAIN_ID=0
ros2 launch nav_cmd_bridge relays.launch.py 
```
wait for atleast 5s for the above relay node to start, you should see a bunch of topics being published. 

`ROBOT_ID` suffixes every relayed topic and relay node name (`/ODOM_relayed_<robot_id>`, `odom_relay_<robot_id>`)
and prefixes every frame id except `map` (`<robot_id>/base_link`), so any number of robots can share one
`ROS_DOMAIN_ID`. Left unset you get the original single-robot names.

Each robot relays only what the laptop draws and the two poses it sends: its odometry (`/ODOM_relayed_<id>`, in the
`map` frame, 10 Hz) and SLAM map (`/GRID_MAP_relayed_<id>`) to the laptop, and `/initialpose_relayed_<id>` and
`/goal_pose_relayed_<id>` from it. The lidar cloud (`/ALIGNED_POINTS`), TF (`/tf`, `/tf_static`) and the front camera stay
on the robot: all robots share one Wi-Fi, and relayed they flooded it. An image built before that relays 8 nodes, not 4;
the GUI's Setup flags it: rebuild and push the image (Build and push, above).

- Step 4 : Localize the robot on the preloaded SLAM map, from the laptop's rviz (rviz2 on the robot is too slow).
In a laptop terminal with the laptop side Step 3 exports:
```bash
rviz2 --ros-args -r /initialpose:=/initialpose_relayed_<robot_id>
```
Set Fixed Frame to `map` (the robot's localizer only knows `map`, not the `<robot_id>/` frames) and enable
/ODOM_relayed_<id> and /GRID_MAP_relayed_<id>. The odometry should roughly match where the robot stands. If it is
drifting, select "2D Pose Estimate", then click and extend the arrow to set the location and heading: the robot's
`initialpose_relay_<id>` hands it to the localizer as `/initialpose`. To localize several robots from one rviz, add
one "2D Pose Estimate" tool per robot with topic /initialpose_relayed_<id>. The tool's default topic, /initialpose,
reaches no robot.

# Laptop side setup

- Step 1 : Connect to the router WiFi "near-robots-5G" 
- Step 2 : Install devcontainer on vscode and open in devcontainer (ctrl + shift + p and select build in devcontainer)
- Step 3 : fix ros domain and fastdds profile (in every laptop terminal)
```bash
export ROS_DOMAIN_ID=0
export FASTRTPS_DEFAULT_PROFILES_FILE=fastdds_profile.xml
source install/setup.bash
```
- Step 4 : Verify if all topics appear 
```bash
ros2 topic list
ros2 topic hz /ODOM_relayed_<robot_id>
```
- Step 5 : Launch rviz on the robots' map and odometry. No TF is relayed: the odometry is already in the `map` frame.
```bash
rviz2 --ros-args -r /goal_pose:=/goal_pose_<robot_id> -r /initialpose:=/initialpose_relayed_<robot_id>
```
Set Fixed Frame to `map`. Per robot id, enable /ODOM_relayed_<id>, plus one /GRID_MAP_relayed_<id>, and add a
"2D Goal Pose" tool with topic /goal_pose_<id>.
"2D Pose Estimate" relocalizes the robot, as in robot side Step 4.
The goal arrow disappears once drawn, so the bridge publishes the waypoints back: Add → By topic →
/waypoint_markers_<id> → MarkerArray. Each waypoint shows as a numbered arrow, green while it is the current target.
- Step 6 : Before you run any nav commands, on the robot controller, standup the robot from controller
- Step 7 : In one terminal per robot, `export ROBOT_ID=<id>` and run any of the following nav bridge commands with that robot's `--ip`
(goals come from /goal_pose_<id>)

```bash
# Single waypoint (add --wait to block until arrival)
ros2 run nav_cmd_bridge nav_cmd_bridge nav <x> <y> [yaw_rad]

# RViz2 bridge — draw a 2D Goal Pose arrow to navigate immediately (USE THIS ONE)
ros2 run nav_cmd_bridge nav_cmd_bridge bridge --ip <robot_ip> 

# RViz2 bridge — queue mode: collect arrows, execute all once on ENTER
ros2 run nav_cmd_bridge nav_cmd_bridge bridge queue --ip <robot_ip> 

# RViz2 bridge — patrol mode: collect 2+ arrows, on ENTER loop 1 → N → 1 … until Ctrl+C
ros2 run nav_cmd_bridge nav_cmd_bridge bridge patrol --ip <robot_ip> 

# Robot emergency stop commands
ros2 run nav_cmd_bridge nav_cmd_bridge estop --ip <robot_ip> 
ros2 run nav_cmd_bridge nav_cmd_bridge cancel --ip <robot_ip> 
```

# Multi-robot navigation (fleet_management.py)

Sends every robot its own goal, or its own list of waypoints, at the same instant. First do the robot side
(localization and relays, each robot with its own `ROBOT_ID`) and laptop Steps 1–4 and 6 for every robot. Every
terminal below needs the Step 3 exports.

- Step 1 : In one terminal per robot, start a plain bridge with that robot's id and ip (IPs from the table above)
```bash
export ROBOT_ID=741
ros2 run nav_cmd_bridge nav_cmd_bridge bridge --ip 192.168.123.100
```
Likewise 665 with `--ip 192.168.123.101` and 738 with `--ip 192.168.123.103`.
- Step 2 : Launch rviz with the "2D Goal Pose" tool publishing on /fleet_goal. No bridge listens there, so drawing
an arrow never moves a robot by itself.
```bash
rviz2 --ros-args -r /goal_pose:=/fleet_goal
```
Set up the displays as in Step 5, but keep only the default "2D Goal Pose" tool: a tool set to /goal_pose_<id>
moves that robot as soon as you draw. Also Add → By topic → /fleet_goal_markers → MarkerArray, which shows the
arrows drawn but not yet sent, coloured per robot and labelled with its id.
- Step 3 : In another terminal, start fleet_management with a mode and the robot ids in the order you will draw
their arrows, then follow that mode below
```bash
python3 scripts/fleet_management.py single-waypoint 741 665 738
python3 scripts/fleet_management.py multi-waypoint 741 665 738
python3 scripts/fleet_management.py multi-waypoint-patrol 741 665 738
```

**single-waypoint** : Draw one arrow per robot in that order (1st arrow → 741, 2nd → 665, 3rd → 738), then press
ENTER in the fleet_management terminal: the goals go out back to back and all robots set off together. `c` + ENTER
clears the arrows so you can redraw them.

**multi-waypoint** : Like `bridge queue`, per robot. Draw 741's waypoints in order, `n` + ENTER, draw 665's,
`n` + ENTER, draw 738's, then ENTER: every robot sets off for its first waypoint together and works through the rest
on its own, without waiting for the others. A robot's next waypoint is sent once its /ODOM_relayed_<id> is within
0.1 m of the current one, or after 125 s. `u` + ENTER drops the current robot's last arrow, `c` + ENTER clears all.

**multi-waypoint-patrol** : Like `bridge patrol`, per robot. Draw and send exactly as in multi-waypoint, but mark
each robot's waypoints as a **closed shape**, at least 3, in order around it (e.g. the 4 corners of a square:
WP1 → WP2 → WP3 → WP4).

# Recording demo waypoints (demo/record_waypoints.sh)

- Step 1 : Robot side (localization and relays, each robot with its own `ROBOT_ID`) and laptop Steps 1–4 and 6 for
every robot.
- Step 2 (optional) : rviz as in Multi-robot Step 2, to see the recorded waypoints on /fleet_goal_markers. Each robot
keeps one colour (its place in the phase's file), and the file's other routes show dimmed. A "2D Goal Pose" arrow drawn
there (on /fleet_goal) is recorded as the current robot's next waypoint, like ENTER.
- Step 3 : From the package root, in a terminal with the laptop Step 3 exports
```bash
demo/record_waypoints.sh                  # all phases in order: patrol formation sweep cordon
demo/record_waypoints.sh sweep cordon     # only these phases
ONLY="665" demo/record_waypoints.sh patrol   # only these robots; the other robots' waypoints in the file are kept
ONLY="738" APPEND=1 demo/record_waypoints.sh sweep   # add waypoints after the ones 738 already has
R1=741 R2=665 R3=738 PATROL_ROBOTS="741 665" demo/record_waypoints.sh   # ids (default 741 665 738, patrol: all three)
demo/record_waypoints.sh aloha            # the Aloha's route to the box, with aloha/bridge.sh running
```
- Step 4 : In each phase, for each robot in the table's order: drive it with its controller to each waypoint and press
ENTER there; `n` + ENTER moves on to the next robot. After the last robot, `w` + ENTER saves
`demo/waypoints/current/<phase>.json` (the plan in use) and starts the next phase. `u` + ENTER undoes the current robot's last waypoint,
`c` + ENTER clears the phase, Ctrl+C quits without saving the current phase.

| Phase | Robots | Waypoints |
|---|---|---|
| patrol | R1 R2 R3 (or PATROL_ROBOTS) | perimeter corners in order, at least 3, first corner not repeated |
| formation | R1 R2 R3 | 1 per robot: line slots 1, 2, 3 |
| sweep | R1 R2 R3 | zone 1, 2, 3 waypoints in order; R3's last next to the box |
| cordon | R1 R2 R3 | 1 per robot: R1 and R2 their cordon points around the box, R3 where it watches the box from |
| aloha | the Aloha (`aloha`, pose from /amcl_pose on ROS_DOMAIN_ID=1) | its route to the box in order; it docks onto the last one. For rviz, `ROS_DOMAIN_ID=1 rviz2 --ros-args -r /goal_pose:=/fleet_goal` with /map and /fleet_goal_markers |

# Running the demo (demo/run_demo.sh)

- Step 1 : `demo/waypoints/current` has `patrol.json`, `formation.json`, `sweep.json` and `cordon.json` (recorded above). Each plan
is a dated folder of `demo/waypoints`; `current` points at the one in use, picked under Routes in the Command Center
(README_gui.md).
- Step 2 : Robot side (localization and relays, each robot with its own `ROBOT_ID`) and laptop Steps 1–4 and 6 for
every robot.
- Step 3 : One plain bridge per robot, as in Multi-robot Step 1.
- Step 4 (optional) : rviz as in Multi-robot Step 2, to see the routes on /fleet_goal_markers.
- Step 5 : From the package root, in a terminal with the laptop Step 3 exports
```bash
demo/run_demo.sh            # DETECT=fixed: the box is reported once R3 stops next to it (below)
DETECT=0 demo/run_demo.sh   # no box reported; every robot sweeps its whole route
```
The Aloha's photos of the box's contents go to a Roboflow workflow, which needs `ROBOFLOW_API_KEY` (Box contents,
below).
- Step 6 : In the same terminal

| When | Type | Next |
|---|---|---|
| patrol running | instruction + ENTER (ENTER alone uses the Zone A instruction) | formation, then plan SR2-01 |
| `Operator approval (approve/deny):` | `approve` + ENTER | sweep, cordon, the Aloha at the box, then the verdict |
| `Operator approval (approve/deny):` | `deny` + ENTER | patrol again |
| `Operator verdict (anomaly/clear):` | `clear` + ENTER, after the Aloha's photo of the contents | every robot back to its formation slot, then the script exits |
| `Operator verdict (anomaly/clear):` | `anomaly` + ENTER | the script exits |
| any time | Ctrl+C | script exits; each robot still drives to the waypoint it has |

Or, instead of Steps 5–6, run it from the operator window, next to the RViz2s:
```bash
python3 demo/demo_gui.py
```
**Start demo** runs `demo/run_demo.sh` exactly as the terminal would, with ROS_DOMAIN_ID=0 and `fastdds_profile.xml`
unless the terminal sets them. The banner says what is going on, and turns black when the operator has to act: type
the instruction and **Send** (empty: the Zone A instruction), then **Approve plan** or **Deny**. The mission plan on the
left is generated once the instruction is sent and is then executed step by step. The window also shows each robot's
status (in progress, done, stopped, failed), every plan generated with its status (generating, awaiting approval,
denied, executing, completed, stopped, failed), and a warning when the fleet cannot send (e.g. a robot not connected).
**Stop demo** is Ctrl+C; **Show** opens the demo's own output.

## The box (demo/assets/box.json) and finding it (demo/find_box.py)

The box stands at a known place on the dogs' map: `demo/assets/box.json` (`x`, `y`, `z`, `yaw` in radians, `length`
and `width` in metres). `fleet_management.py` draws it in RViz from there (`show_box`), and the Command Center from there
too. Edit that file when the box moves. A UWB tag on the box will later replace it with a live topic.

With `DETECT=fixed`, the default, `run_demo.sh` starts `demo/find_box.py` with the sweep. Once R3 (738) is within 2 m of
the box (`--reach`) and has stood still for a second, it prints, then exits:
`[DETECT] Box found by robot 738 at x=1.45 y=6.51 (map), 1.6 m away, confidence 1.00, image …/demo/assets/unattended_item.jpg`.
The dogs' cameras stay on the dogs, so the photo is one taken beforehand, `demo/assets/unattended_item.jpg`
(`--image <photo>` for another, `--image none` for none). The Command Center pops it up, enlarged, the moment the box
is found, and keeps it in the Suspicious item card, whose image opens it again; `demo_gui.py` shows it too. The sweep goes on to its end either way. R3's last sweep waypoint
must therefore end near the box. To try it alone, with the fleet's exports: `python3 demo/find_box.py`.

## The cameras the Command Center shows

Only the ALOHA's two wrist cameras: `/camera_l/color/image_throttled/compressed` and `/camera_r/…` come over its bridge
(ROS_DOMAIN_ID=1), throttled on the robot by `aloha/robot/stream.launch` to `fps` (3). They also photograph the box (Box
contents, below). The dogs' cameras stay on the dogs (robot side Step 3), and the ALOHA's centre camera (`camera_f`) on
the ALOHA: over the shared Wi-Fi, they flooded it.

The ALOHA's bridge (`aloha/bridge.yaml`) carries only what the laptop uses: the map, AMCL's pose and particles, the
scan and TF (for RViz's Localize view), the initial pose and navigation goals, move_base's status, the arms' joints
(`/puppet/joint_*` read, `/master/joint_*` commanded), the two wrist cameras and docking. The arms' end poses and status
(200 Hz each), move_base's plans and the centre camera stay on the robot.

## The ALOHA to the box (aloha/send_goal.py)

`aloha/run_aloha.sh` drives the ALOHA along `aloha.json` with `send_goal.py --dock`: `move_base` takes each waypoint
(through the bridge, `/move_base_simple/goal`), then `dock.py` on the robot docks precisely onto the last one, through
`/aloha/dock/goal`. The last waypoint is the dock pose, right by the box, which is an obstacle in `move_base`'s costmap:
when `move_base` cannot get there it says `WP n/n not reached by move_base (ABORTED): docking onto it from where it
stands`, and `dock.py` takes over. `dock.py` docks only from within 0.5 m and 0.5 rad (its `max_xy`, `max_yaw`); further
off it answers `… too far to dock, move_base did not get there` and the run fails there. Both need the ALOHA localized
on its own map (the Command Center's Setup, step d): from a wrong pose `move_base` finds no plan at all.

Crop the ALOHA's map after saving it: a saved map is 4000 x 4000 cells (16 MB) however little is known, and
`map_server` sends all of it through the bridge at every start of either, for minutes on the ALOHA's Wi-Fi, during which
RViz and the Command Center show no map. On the ALOHA, `python3 crop_map.py <map.yaml>` (`aloha/robot/crop_map.py`,
copied next to `start_aloha.sh`) keeps the known part plus 2 m, a few hundred KB, and moves the origin with it, so map
coordinates and recorded waypoints stay valid. It keeps the originals as `.orig`. Then restart `map_server` (the
`navigation` window: Ctrl+C, Up, Enter).

## Box contents (aloha/inspect_box.py, Roboflow workflow)

When the Aloha's arms reach the last pose but one, before they go home, `manipulator.py` prints `[INSPECT] Taking
photos with both wrist cameras` and saves the first frame each wrist camera took once the arms were there:
`demo/detections/contents_…_left.jpg` and `_right.jpg`. It listens to both cameras from the start, and compares their
stamps with the arms' (both the ALOHA's clock), so the photos are taken at once whatever the Wi-Fi's delay. The arms
hold the pose until both photos are in (10 s at most), then 2 s longer, then go home. `--photo-pose N`
(`run_manipulator.sh`) photographs at another pose. While they go home, `aloha/inspect_box.py` sends both photos, in one
request, to the Roboflow workflow **Carton Interior Mask Preview** (workspace `test001-78x0i`, workflow
`carton-interior-mask-preview-1795512106163`, on `serverless.roboflow.com`) through `aloha/carton_workflow.py`. The
workflow finds the carton's interior in each photo (model carton-interior-segmentation), blanks everything outside it,
and only then finds the objects in it (model carton-contents-detection: bottle, screwdriver, tape_roll,
warning_taped_box, wire). `inspect_box.py` prints each object once, at its best confidence over both photos, and the
workflow's drawings of both photos side by side, each object boxed with its class and confidence:
`[INSPECT] Box contents: warning_taped_box 0.97, bottle 0.92; image demo/detections/contents_….jpg`. Each photo's
drawing is kept too, as `contents_…_left_annotated.jpg` and `_right_annotated.jpg`.
A photo in which the workflow finds no carton interior goes in as taken, after
`[INSPECT] No photo of the inside: the workflow found no carton interior in contents_…_left.jpg`, which the operator
window shows as a warning: "nothing found" then means the box was not looked into, not that it is empty. When the
workflow cannot be run (no key, a refused key, no answer after 3 tries of 30 s), it prints `[INSPECT] Cannot run: …`
instead, and `manipulator.py` waits 100 s at most for either.
The operator window shows that image under the box's image, with the list of objects.
It then asks at once for the operator's verdict: **Anomaly** or **Clear**. After **Clear**, R1, R2 and R3 go back to
their formation slots (`formation.json`), the mission plan's last step, and the demo ends once they are there. After
**Anomaly**, the demo ends at once and that step shows as skipped. A verdict given before `run_demo.sh` asks is kept until it asks. Click either image, or **⤢ Enlarge**, to
see it in a window of its own. Maximize that window (or double-click it, or press F) to fill the screen; Esc closes it.

- Once: the Roboflow API key (app.roboflow.com/settings/api) as `ROBOFLOW_API_KEY=<key>` in `.env` at the package root,
  which git and Docker builds ignore, or exported in the terminal that runs the demo (that one wins). It goes only in
  the request's `Authorization` header. Never commit it.
- The laptop needs internet access during the demo: the workflow runs on Roboflow's servers.
- Pillow, for the side-by-side image: `pip3 install Pillow` (`requirements.txt`'s matplotlib already brings it).
  Nothing else: the client is plain `urllib`, as ROS 2 Foxy's python3 is 3.8 and Roboflow's `inference-sdk` needs 3.10.
- The workflow's steps and models are edited on Roboflow (workspace `test001-78x0i`, Workflows). `carton_workflow.py`
  reads only its outputs `interior_count`, `predictions` and `output_image`, and asks for no others. If one is renamed,
  `inspect_box.py` says `Cannot run: … the result for … has …, not interior_count, predictions, output_image`.
- To try it alone on photos already taken: `python3 aloha/inspect_box.py demo/detections/contents_…_left.jpg demo/detections/contents_…_right.jpg`.
- To check the key and the workflow: `python3 aloha/test_carton_workflow.py`, a smoke test on
  `aloha/samples/carton_open.jpg` and a picture without a carton, against the live workflow (about 5 s). Without a key
  only its offline test runs.
