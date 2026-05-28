# nav_cmd_bridge

Navigation command bridge for DeepRobotics M20 Pro. Sends waypoints over UDP and subscribes to `ODOM_relayed` for position tracking. Supports RViz2-driven navigation, multi-robot fleets (per-robot ROS namespaces, shared `map` frame, prefixed TF), and structured benchmark testing (T1–T4).

## Building

Requires ROS 2 Foxy.

```bash
cd ~/colcon_ws
colcon build --packages-select nav_cmd_bridge
source install/setup.bash
```

## Bridge — direct navigation

The C++ node handles navigation commands. All commands accept `--ip <addr>` to override the default robot IP (`10.21.31.103`).

```bash
# Single waypoint
ros2 run nav_cmd_bridge nav_cmd_bridge nav <x> <y> [yaw_rad]

# Multiple waypoints in sequence (single robot — must be run inside a namespace
# so /ODOM_relayed resolves to /<robot_name>/ODOM_relayed)
ros2 run nav_cmd_bridge nav_cmd_bridge patrol <x,y,yaw> <x,y,yaw> ... \
    --ip <robot_ip> --ros-args -r __ns:=/<robot_name>

# preprogrammed waypoints for demo (robot_665)
ros2 run nav_cmd_bridge nav_cmd_bridge patrol --ip 192.168.8.103 \
    -3.20162,-3.81141,-0.0404694 -1.72499,-3.88239,0.0412739 0.200177,-1.78368,0.00477056 \
    --ros-args -r __ns:=/robot_665

# RViz2 bridge — draw a 2D Goal Pose arrow to navigate immediately
# (the launch files below are usually easier; this is the raw form)
ros2 run nav_cmd_bridge nav_cmd_bridge bridge \
    --ip <robot_ip> --ros-args -r __ns:=/<robot_name>

# RViz2 bridge — queue mode
ros2 run nav_cmd_bridge nav_cmd_bridge bridge queue \
    --ip <robot_ip> --ros-args -r __ns:=/<robot_name>

# Robot commands
ros2 run nav_cmd_bridge nav_cmd_bridge estop
ros2 run nav_cmd_bridge nav_cmd_bridge cancel

# Override robot IP
ros2 run nav_cmd_bridge nav_cmd_bridge bridge --ip 192.168.8.101

# to stand up
ros2 run nav_cmd_bridge nav_cmd_bridge standup

```


## Bridge — launch file

All bridge launches put nodes under a per-robot namespace (`/<robot_name>/...`).
RViz must publish goals to `/<robot_name>/goal_pose` to target a specific robot.

### Single robot

```bash
# Defaults: robot_name=robot_741, robot_ip=192.168.8.101
ros2 launch nav_cmd_bridge bridge.launch.py

# Queue mode
ros2 launch nav_cmd_bridge bridge.launch.py queue:=true

# Specify a different robot
ros2 launch nav_cmd_bridge bridge.launch.py \
    robot_name:=robot_665 robot_ip:=192.168.8.103
```

### Multi-robot

```bash
# Default fleet (defined in launch/multirobot.launch.py)
ros2 launch nav_cmd_bridge multirobot.launch.py

# Custom fleet — comma-separated name:ip pairs
ros2 launch nav_cmd_bridge multirobot.launch.py \
    robots:=robot_741:192.168.8.101,robot_738:192.168.8.102,robot_665:192.168.8.103

# Queue mode applied to every robot in the fleet
ros2 launch nav_cmd_bridge multirobot.launch.py queue:=true
```

The multirobot launch spawns per-robot tf fan-in relays plus a namespaced
`nav_cmd_bridge` bridge for each robot. The robots already publish frame-
prefixed TF (see [multirobot_setup.md](multirobot_setup.md)), so all robots
share a single `map` frame and RViz sees:

```
map
├── robot_741/odom -> robot_741/base_link
├── robot_738/odom -> robot_738/base_link
└── robot_665/odom -> robot_665/base_link
```

To send a goal in RViz, set the 2D Goal Pose tool's topic to
`/<robot_name>/goal_pose` (right-click the tool or edit the panel config).

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
