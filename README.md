# nav_cmd_bridge

Navigation command bridge for DeepRobotics M20 Pro. Sends waypoints over UDP, subscribes to `/ODOM` for position tracking, and supports structured benchmark testing (T1–T4) with Excel output.

## Building

Requires ROS 2 Foxy.

```bash
# From your colcon workspace (e.g. ~/colcon_ws)
cd ~/colcon_ws/src
ln -s /path/to/near-native-nav-bridge nav_cmd_bridge

cd ~/colcon_ws
colcon build --packages-select nav_cmd_bridge
source install/setup.bash
```

## Usage

### C++ node directly

```bash
# Single waypoint
ros2 run nav_cmd_bridge nav_cmd_bridge nav <x> <y> [yaw]

# Multi-waypoint patrol
ros2 run nav_cmd_bridge nav_cmd_bridge patrol <x,y,yaw> <x,y,yaw> ...

# RViz2 bridge (draw arrows to navigate)
ros2 run nav_cmd_bridge nav_cmd_bridge bridge
ros2 run nav_cmd_bridge nav_cmd_bridge bridge queue

# Robot commands
ros2 run nav_cmd_bridge nav_cmd_bridge status
ros2 run nav_cmd_bridge nav_cmd_bridge loc
ros2 run nav_cmd_bridge nav_cmd_bridge stand
ros2 run nav_cmd_bridge nav_cmd_bridge sit
ros2 run nav_cmd_bridge nav_cmd_bridge estop
ros2 run nav_cmd_bridge nav_cmd_bridge cancel
ros2 run nav_cmd_bridge nav_cmd_bridge heartbeat
ros2 run nav_cmd_bridge nav_cmd_bridge monitor
ros2 run nav_cmd_bridge nav_cmd_bridge nav_mode
ros2 run nav_cmd_bridge nav_cmd_bridge regular_mode
ros2 run nav_cmd_bridge nav_cmd_bridge gait_flat
ros2 run nav_cmd_bridge nav_cmd_bridge gait_stair
ros2 run nav_cmd_bridge nav_cmd_bridge clearqueue

# Optional flags
--csv /path/to/output.csv    # override CSV output path
--json                       # machine-readable output (loc only)
```

### Python run.py

`run.py` wraps the C++ binary and adds benchmark test orchestration.

```bash
# Install Python dependency (for Excel generation)
pip install openpyxl

# Passthrough commands (same as C++ directly)
python3 scripts/run.py nav 2.15 0.83 1.567
python3 scripts/run.py patrol 2.0,1.0,0.0 4.0,2.0,1.57
python3 scripts/run.py bridge
python3 scripts/run.py stand
# ... any C++ command works here
```

### Benchmark tests

Create a waypoints file (CSV, one waypoint per line):

```
# waypoints.csv
# x, y, yaw_rad
2.15, 0.83, 1.567
4.00, 2.00, 0.000
0.50, 3.10, 3.140
1.20, 1.50, 0.785
```

Run tests:

```bash
# T1 – SLAM loop closure (teleoperation-based)
# Press ENTER to record start pose, teleoperate the loop, press ENTER to record end pose
python3 scripts/run.py test T1 --map office --trials 5

# T2/T3/T4 – Navigation tests with waypoints from file
python3 scripts/run.py test T2 --map office --waypoints waypoints.csv
python3 scripts/run.py test T3 --map office --waypoints waypoints.csv
python3 scripts/run.py test T4 --map office --waypoints waypoints.csv

# T2/T3/T4 – Navigation tests with waypoints from RViz2
# Uses bridge queue mode – draw arrows in RViz2, press ENTER to execute
python3 scripts/run.py test T2 --map office --bridge
python3 scripts/run.py test T3 --map office --bridge
python3 scripts/run.py test T4 --map office --bridge
```

Results are saved to `~/nav_benchmarks/<timestamp>/` as structured CSVs and an Excel workbook.

To regenerate Excel from existing CSVs:

```bash
python3 scripts/run.py excel ~/nav_benchmarks/2026-04-16_143052/
```
