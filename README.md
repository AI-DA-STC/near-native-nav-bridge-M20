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

```bash
docker pull --platform linux/arm64 192.168.123.160:5000/m20-bridge:foxy
docker tag  192.168.123.160:5000/m20-bridge:foxy m20-bridge:foxy     # restore the clean name
```

# localization on robot

- Step 1 : Connect to the router WiFi "near-robots-5G" 
- Step 2 : SSH into the robot like so : 
```bash
ssh user@192.168.8.101, password = ' (single quote)
```
- Step 3 : Robot localization verification

ensure robot is localized on the preloaded SLAM map by running the following on the robot
```bash
su
source /opt/ros/foxy/setup.bash
rviz2
```
- on the rviz, look for the 3D ODOM position of the robot, it should somewhat reflect its current position. 
If it is drifting, select "2D Pose Estimate", then click and extend the arrow to set the location and heading.
- After the robot relozalises, close and save rviz

- Step 4 : Run the relay node to convert DeepRobotics topics to ROS topics 

```bash
docker compose up -d nav_cmd_bridge
docker exec -it nav_cmd_bridge bash
export ROBOT_ID=<robot_id>
export ROS_DOMAIN_ID=0
ros2 launch nav_cmd_bridge relays.launch.py 
```
wait for atleast 2 mins for the above relay node to start, you should see a bunch of topics being published. 

`ROBOT_ID` suffixes every relayed topic and relay node name (`/ODOM_relayed_<robot_id>`, `odom_relay_<robot_id>`)
and prefixes every frame id except `map` (`<robot_id>/base_link`), so any number of robots can share one
`ROS_DOMAIN_ID`. All robots publish TF into the shared `/tf_relayed` and `/tf_static_relayed`, so they
must all run the same map. Left unset you get the original single-robot names.

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
- Step 5 : Launch rviz on the robots' shared TF. Do not relay TF into `/tf`: the robots would relay it back in a loop.
```bash
rviz2 --ros-args -r /tf:=/tf_relayed -r /tf_static:=/tf_static_relayed -r /goal_pose:=/goal_pose_<robot_id>
```
Set Fixed Frame to `map`. Per robot id, enable /ALIGNED_POINTS_relayed_<id>, /ODOM_relayed_<id> and
/NAV_POINTS_relayed_<id>, plus one /GRID_MAP_relayed_<id>, and add a "2D Goal Pose" tool with topic /goal_pose_<id>.
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
rviz2 --ros-args -r /tf:=/tf_relayed -r /tf_static:=/tf_static_relayed -r /goal_pose:=/fleet_goal
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
- Step 2 (optional) : rviz as in Multi-robot Step 2, to see the recorded waypoints on /fleet_goal_markers.
- Step 3 : From the package root, in a terminal with the laptop Step 3 exports
```bash
demo/record_waypoints.sh                  # all phases in order: patrol formation sweep cordon
demo/record_waypoints.sh sweep cordon     # only these phases
ONLY="665" demo/record_waypoints.sh patrol   # only these robots; the other robots' waypoints in the file are kept
R1=741 R2=665 R3=738 PATROL_ROBOTS="741 665" demo/record_waypoints.sh   # ids (default 741 665 738, patrol: all three)
```
- Step 4 : In each phase, for each robot in the table's order: drive it with its controller to each waypoint and press
ENTER there; `n` + ENTER moves on to the next robot. After the last robot, `w` + ENTER saves
`demo/waypoints/<phase>.json` and starts the next phase. `u` + ENTER undoes the current robot's last waypoint,
`c` + ENTER clears the phase, Ctrl+C quits without saving the current phase.

| Phase | Robots | Waypoints |
|---|---|---|
| patrol | R1 R2 R3 (or PATROL_ROBOTS) | perimeter corners in order, at least 3, first corner not repeated |
| formation | R1 R2 R3 | 1 per robot: line slots 1, 2, 3 |
| sweep | R1 R2 R3 | zone 1, 2, 3 waypoints in order; R3's last next to the box |
| cordon | R1 R2 | 1 per robot: cordon point at zone 3 |

# Running the demo (demo/run_demo.sh)

- Step 1 : `demo/waypoints/` has `patrol.json`, `formation.json`, `sweep.json` and `cordon.json` (recorded above).
- Step 2 : Robot side (localization and relays, each robot with its own `ROBOT_ID`) and laptop Steps 1–4 and 6 for
every robot.
- Step 3 : One plain bridge per robot, as in Multi-robot Step 1.
- Step 4 (optional) : rviz as in Multi-robot Step 2, to see the routes on /fleet_goal_markers.
- Step 5 : From the package root, in a terminal with the laptop Step 3 exports
```bash
demo/run_demo.sh
```
- Step 6 : In the same terminal

| When | Type | Next |
|---|---|---|
| patrol running | instruction + ENTER (ENTER alone uses the Zone A instruction) | formation, then plan SR2-01 |
| `Operator approval (approve/deny):` | `approve` + ENTER | sweep, then cordon, then the script exits |
| `Operator approval (approve/deny):` | `deny` + ENTER | patrol again |
| any time | Ctrl+C | script exits; each robot still drives to the waypoint it has |
