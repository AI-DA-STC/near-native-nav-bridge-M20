# nav_cmd_bridge

Navigation command bridge for DeepRobotics M20 Pro. Sends waypoints over UDP and subscribes to `/ODOM` for position tracking. Supports RViz2-driven navigation and structured benchmark testing (T1–T4).

# Robot side setup

- Step 1 : Connect to the router WiFi "near-robots-2.4G" 
- Step 2 : Use the robot id 741 for reproducing best results. SSH into the robot like so : 
```bash
ssh user@192.168.8.101, password = ' (single quote)
```
- Step 3 : Robot localization verification

ensure robot is localized on the preloaded SLAM map
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
exit #exist the super user
export ROS_DOMAIN_ID=0
export FASTRTPS_DEFAULT_PROFILES_FILE=/home/user/fastdds_profile.xml
export ROBOT_ID=741   # this robot's id — alphanumeric/underscore only
cd workspace/ros2_ws
source install/setup.bash
ros2 launch nav_cmd_bridge relays.launch.py 
```
wait for atleast 2 mins for the above relay node to start, you should see a bunch of topics being published. 

`ROBOT_ID` suffixes every relayed topic and relay node name (`/ODOM_relayed_741`, `odom_relay_741`)
and prefixes every frame id except `map` (`741/base_link`), so any number of robots can share one
`ROS_DOMAIN_ID`. All robots publish TF into the shared `/tf_relayed` and `/tf_static_relayed`, so they
must all run the same map. Left unset you get the original single-robot names.

# Laptop side setup

- Step 1 : Connect to the router WiFi "near-robots-2.4G" 
- Step 2 : fix ros domain and fastdds profile (in every laptop terminal)
```bash
export ROS_DOMAIN_ID=0
export FASTRTPS_DEFAULT_PROFILES_FILE=/root/ros2_ws/src/nav_cmd_bridge/fastdds_profile.xml
cd ~/ros2_ws
source install/setup.bash
```
- Step 3 : Verify if all topics appear 
```bash
ros2 topic list
ros2 topic echo /ODOM_relayed_741
```
- Step 4 : Launch rviz on the robots' shared TF. Do not relay TF into `/tf`: the robots would relay it back in a loop.
```bash
rviz2 --ros-args -r /tf:=/tf_relayed -r /tf_static:=/tf_static_relayed
```
Set Fixed Frame to `map`. Per robot id, enable /ALIGNED_POINTS_relayed_<id>, /ODOM_relayed_<id> and
/NAV_POINTS_relayed_<id>, plus one /GRID_MAP_relayed_<id>, and add a "2D Goal Pose" tool with topic /goal_pose_<id>.
- Step 4 : Before you run any nav commands, on the robot controller, standup the robot.
- Step 5 : In one terminal per robot, `export ROBOT_ID=<id>` and start the nav bridge with that robot's `--ip`
(goals come from /goal_pose_<id>)

```bash
# Single waypoint
ros2 run nav_cmd_bridge nav_cmd_bridge nav <x> <y> [yaw_rad]

# Multiple waypoints in sequence
ros2 run nav_cmd_bridge nav_cmd_bridge patrol <x,y,yaw> <x,y,yaw> ...
#preprogrammed waypoints for demo through door
ros2 run nav_cmd_bridge nav_cmd_bridge patrol --ip 192.168.8.101 -3.20162,-3.81141,-0.0404694 -1.72499,-3.88239,0.0412739 0.200177,-1.78368,0.00477056

# RViz2 bridge — draw a 2D Goal Pose arrow to navigate immediately
ros2 run nav_cmd_bridge nav_cmd_bridge bridge --ip 192.168.8.101

# RViz2 bridge — queue mode: collect arrows, execute all on ENTER
ros2 run nav_cmd_bridge nav_cmd_bridge bridge queue --ip 192.168.8.101

# Robot emergency stop commands
ros2 run nav_cmd_bridge nav_cmd_bridge estop --ip 192.168.8.101
ros2 run nav_cmd_bridge nav_cmd_bridge cancel --ip 192.168.8.101
```

# Docker build and deploy to robot

The robot is arm64, the laptop is x86, so the image is cross-built on the laptop and pushed
through a plain-HTTP registry running on the laptop itself.

## One-time setup

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

On **robot**, trust the laptop's plain-HTTP registry, then restart docker:
```bash
# /etc/docker/daemon.json   (<WS_IP> = laptop's address on the 10.21.31.x LAN)
{ "insecure-registries": ["<WS_IP>:5000"] }
sudo systemctl restart docker
```

## Build and push (on laptop)

```bash
docker buildx build --platform linux/arm64 -f Dockerfile.deploy -t m20-bridge:foxy --load .
docker tag  m20-bridge:foxy localhost:5000/m20-bridge:foxy   # localhost = auto-insecure, no config
docker push localhost:5000/m20-bridge:foxy                   # progress + only changed layers
```

## Pull and run (on robot)

```bash
docker pull --platform linux/arm64 <WS_IP>:5000/m20-bridge:foxy
docker tag  <WS_IP>:5000/m20-bridge:foxy m20-bridge:foxy     # restore the clean name
docker compose up nav_cmd_bridge                             # service running image m20-bridge:foxy
```

# Pls ignore the following commands. To archive later. 

## Bridge — launch file

```bash
# Immediate mode (default)
ros2 launch nav_cmd_bridge bridge.launch.py

# Queue mode
ros2 launch nav_cmd_bridge bridge.launch.py queue:=true

# Custom robot IP
ros2 launch nav_cmd_bridge bridge.launch.py robot_ip:=192.168.8.101
```

## Benchmark tests

### Waypoints file

Create a CSV with one waypoint per line (yaw in radians, optional):

```
# x, y, yaw_rad
2.15, 0.83, 1.567
4.00, 2.00, 0.000
0.50, 3.10, 3.140
```

### Run via launch file

```bash
# T1 — SLAM loop closure (teleoperation-based, 5 trials)
ros2 launch nav_cmd_bridge benchmark.launch.py test:=T1 map:=office

# T2/T3/T4 — waypoint navigation from file
ros2 launch nav_cmd_bridge benchmark.launch.py test:=T2 map:=office waypoints:=/path/to/wps.csv
ros2 launch nav_cmd_bridge benchmark.launch.py test:=T3 map:=office waypoints:=/path/to/wps.csv
ros2 launch nav_cmd_bridge benchmark.launch.py test:=T4 map:=office waypoints:=/path/to/wps.csv

# T2/T3/T4 — collect waypoints from RViz2 (draw arrows, press ENTER to run)
ros2 launch nav_cmd_bridge benchmark.launch.py test:=T2 map:=office

# Multiple trials
ros2 launch nav_cmd_bridge benchmark.launch.py test:=T2 map:=office waypoints:=wps.csv trials:=3

# Custom output directory
ros2 launch nav_cmd_bridge benchmark.launch.py test:=T2 map:=office waypoints:=wps.csv output_dir:=/tmp/results
```

### Run directly

```bash
pip install openpyxl   # for Excel output (optional)

python3 scripts/benchmark.py T1 --map office --trials 5
python3 scripts/benchmark.py T2 --map office --waypoints wps.csv
python3 scripts/benchmark.py T2 --map office --bridge   # RViz2 waypoint collection
```

### Output

Results are saved to `assets/outputs/<timestamp>/`:

| File | Contents |
|---|---|
| `T1_SLAM_Loop_Closure.csv` | LCE and heading drift per trial |
| `T2_Nav_No_Obstacles.csv` | Waypoint reach results |
| `T3_Nav_Static_Obs.csv` | Waypoint reach results |
| `T4_Nav_Dynamic_Obs.csv` | Waypoint reach results |
| `SLAM_Nav_Benchmark.xlsx` | Formatted Excel workbook (requires openpyxl) |

### Pass criteria

| Test | Metric | Threshold |
|---|---|---|
| T1 | LCE < 0.15 m AND Δθ < 5° | > 4/5 trials pass |
| T2 | Waypoint within 0.1 m | > 8/10 waypoints |
| T3 | Waypoint within 0.1 m | > 6/10 waypoints |
| T4 | Waypoint within 0.1 m | > 6/10 waypoints |
