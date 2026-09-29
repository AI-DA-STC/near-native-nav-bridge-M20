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
Robot 834 : 192.168.123.102

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
Likewise 665 with `--ip 192.168.123.101` and 834 with `--ip 192.168.123.102`.
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
python3 scripts/fleet_management.py single-waypoint 741 665 834
python3 scripts/fleet_management.py multi-waypoint 741 665 834
python3 scripts/fleet_management.py multi-waypoint-patrol 741 665 834
```

**single-waypoint** : Draw one arrow per robot in that order (1st arrow → 741, 2nd → 665, 3rd → 834), then press
ENTER in the fleet_management terminal: the goals go out back to back and all robots set off together. `c` + ENTER
clears the arrows so you can redraw them. Nothing is sent until every robot has an arrow and a bridge listening on
/goal_pose_<id>. Once sent, the next arrows start again from the first robot.

**multi-waypoint** : Like `bridge queue`, per robot. Draw 741's waypoints in order, `n` + ENTER, draw 665's,
`n` + ENTER, draw 834's, then ENTER: every robot sets off for its first waypoint together and works through the rest
on its own, without waiting for the others. A robot's next waypoint is sent once its /ODOM_relayed_<id> is within
0.1 m of the current one, or after 125 s. `u` + ENTER drops the current robot's last arrow, `c` + ENTER clears all.
Nothing is sent until every robot has a waypoint, a bridge listening, odometry, and has finished its previous route.
The fleet_management terminal prints each ARRIVED / TIMEOUT and when a robot has finished; keep it running until
then, since it sends the later waypoints.

**multi-waypoint-patrol** : Like `bridge patrol`, per robot. Draw and send exactly as in multi-waypoint, but mark
each robot's waypoints as a **closed shape**, at least 3, in order around it (e.g. the 4 corners of a square:
WP1 → WP2 → WP3 → WP4). After its last waypoint a robot drives straight back to WP1 and loops, each robot at its own
pace; the terminal prints each robot's lap. Do not redraw WP1 at the end: the closing leg (WP4 → WP1) is added for
you, and /fleet_goal_markers draws it so you can check the shape before ENTER. `s` + ENTER stops the patrols: each
robot stops at the waypoint it is driving to, and then a new plan can be sent. Ctrl+C in the fleet_management
terminal also stops sending waypoints, but each robot still drives to the one it already has.
