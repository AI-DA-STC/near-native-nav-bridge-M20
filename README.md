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
xport ROS_DOMAIN_ID=0
export FASTRTPS_DEFAULT_PROFILES_FILE=/home/user/fastdds_profile.xml
cd workspace/ros2_ws
source install/setup.bash
ros2 launch nav_cmd_bridge relays.launch.py 
```
wait for atleast 2 mins for the above relay node to start, you should see a bunch of topics being published. 

# Laptop side setup

- Step 1 : Connect to the router WiFi "near-robots-2.4G" 
- Step 2 : fix ros domain, fastdds profile and change tf topics for rviz compliant names
```bash
export ROS_DOMAIN_ID=0
export FASTRTPS_DEFAULT_PROFILES_FILE=/root/ros2_ws/src/nav_cmd_bridge/fastdds_profile.xml
cd ~/ros2_ws
source install/setup.bash
ros2 run nav_cmd_bridge tfmessage_relay --ros-args -p input_topic:=/tf_relayed -p output_topic:=/tf &
ros2 run nav_cmd_bridge tfmessage_relay --ros-args \
  -p input_topic:=/tf_static_relayed -p output_topic:=/tf_static \
  -p durability:=transient_local &
```
- Step 3 : Verify if all topics appear 
```bash
ros2 topic list
ros2 topic echo /ODOM_relayed
```
- Step 4 : Launch rviz and enable the following topics : 
(1) /ALIGNED_POINTS_relayed
(2) /ODOM_relayed
(3) /GRID_MAP_relayed
(4) /NAV_POINTS_relayed
- Step 4 : Before you run any nav commands, on the robot controller, standup the robot.
- Step 5 : In another terminal, start the nav bridge node to send waypoints

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
