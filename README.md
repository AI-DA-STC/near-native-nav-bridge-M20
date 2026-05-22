# nav_cmd_bridge

Navigation command bridge for DeepRobotics M20 Pro. Sends waypoints over UDP and subscribes to `/ODOM` for position tracking. Supports RViz2-driven navigation and structured benchmark testing (T1–T4).

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

# Multiple waypoints in sequence
ros2 run nav_cmd_bridge nav_cmd_bridge patrol <x,y,yaw> <x,y,yaw> ...

# RViz2 bridge — draw a 2D Goal Pose arrow to navigate immediately
ros2 run nav_cmd_bridge nav_cmd_bridge bridge

# RViz2 bridge — queue mode: collect arrows, execute all on ENTER
ros2 run nav_cmd_bridge nav_cmd_bridge bridge queue

# Robot commands
ros2 run nav_cmd_bridge nav_cmd_bridge estop
ros2 run nav_cmd_bridge nav_cmd_bridge cancel

# Override robot IP
ros2 run nav_cmd_bridge nav_cmd_bridge bridge --ip 192.168.8.101

# to stand up
ros2 run nav_cmd_bridge nav_cmd_bridge standup

```


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
