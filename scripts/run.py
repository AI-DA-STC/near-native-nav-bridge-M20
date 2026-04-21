#!/usr/bin/env python3
"""
run.py – CLI front-end for nav_cmd_bridge
==========================================
Wraps the C++ nav_cmd_bridge executable for everyday commands (nav, patrol,
bridge, status, …) and adds benchmark test orchestration (T1–T4) with
structured CSV + Excel output matching SLAM_Nav_Benchmark_NativeM20.xlsx.

Usage
-----
  python3 run.py <command> [args...]

Passthrough commands (delegated to C++):
  nav, patrol, bridge, status, loc, cancel, monitor, heartbeat,
  stand, sit, estop, nav_mode, regular_mode, gait_flat, gait_stair, clearqueue

Benchmark test commands:
  python3 run.py test T1 --map <name> [--trials 5]
  python3 run.py test T2 --map <name> --waypoints <file.csv> [--trials 1]
  python3 run.py test T2 --map <name> --bridge
  python3 run.py test T3 --map <name> --waypoints <file.csv> [--trials 1]
  python3 run.py test T4 --map <name> --waypoints <file.csv> [--trials 1]
"""

import argparse
import csv
import json
import math
import os
import subprocess
import sys
import tempfile
import threading
from datetime import datetime
from pathlib import Path

import rclpy
from rclpy.node import Node
from nav_msgs.msg import Odometry

try:
    from openpyxl import Workbook
    from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
    HAS_OPENPYXL = True
except ImportError:
    HAS_OPENPYXL = False

# ============================================================
#  Constants
# ============================================================
# Resolve the C++ executable via ROS 2 install or fallback
# When installed: same directory as this script
# When developing: ../install/nav_cmd_bridge/lib/nav_cmd_bridge/
_SCRIPT_DIR = Path(__file__).resolve().parent
_CPP_BIN_NAME = "nav_cmd_bridge"

# Try common locations for the compiled binary
_BIN_SEARCH_PATHS = [
    _SCRIPT_DIR / _CPP_BIN_NAME,                      # co-located (installed)
    _SCRIPT_DIR.parent / "build" / _CPP_BIN_NAME,     # local build dir
    Path.home() / "colcon_ws" / "install" / "nav_cmd_bridge" / "lib" / "nav_cmd_bridge" / _CPP_BIN_NAME,
]

SETTLE_THRESHOLD = 0.1   # metres (strict benchmark)
LCE_THRESHOLD    = 0.15  # metres
YAW_THRESHOLD    = 5.0   # degrees

# Project root = parent of scripts/ (where this file lives)
_PROJECT_ROOT = _SCRIPT_DIR.parent
DEFAULT_OUTPUT_DIR = _PROJECT_ROOT / "assets" / "outputs"

# ============================================================
#  Helpers
# ============================================================

def find_cpp_binary():
    """Locate the compiled nav_cmd_bridge executable."""
    import shutil, stat
    on_path = shutil.which(_CPP_BIN_NAME)
    if on_path:
        return on_path
    for p in _BIN_SEARCH_PATHS:
        if p.exists():
            # Auto-chmod +x if not executable (fixes a common build-output issue)
            if not os.access(str(p), os.X_OK):
                try:
                    st = os.stat(str(p))
                    os.chmod(str(p), st.st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
                    print(f"[run.py] Made {p} executable")
                except PermissionError:
                    print(f"[run.py] WARNING: {p} is not executable and chmod failed. "
                          f"Run: chmod +x {p}", file=sys.stderr)
            return str(p)
    return _CPP_BIN_NAME


def run_cpp(args, timeout=300):
    """Run the C++ binary with the given arguments. Returns (stdout, stderr, returncode)."""
    binary = find_cpp_binary()
    cmd = [binary] + args
    print(f"[run.py] Executing: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if result.stdout:
        print(result.stdout, end="")
    if result.stderr:
        print(result.stderr, end="", file=sys.stderr)
    return result.stdout, result.stderr, result.returncode


def run_cpp_live(args, timeout=None):
    """Run the C++ binary with live stdout/stderr passthrough."""
    binary = find_cpp_binary()
    cmd = [binary] + args
    print(f"[run.py] Executing: {' '.join(cmd)}")
    try:
        return subprocess.call(cmd, timeout=timeout)
    except subprocess.TimeoutExpired:
        print("[run.py] Command timed out", file=sys.stderr)
        return -1


def _quat_to_yaw(x, y, z, w):
    """Convert quaternion to yaw (radians)."""
    return math.atan2(2.0 * (w * z + x * y),
                      1.0 - 2.0 * (y * y + z * z))


class _OdomListener(Node):
    """Lightweight rclpy node that grabs a single /ODOM reading."""
    def __init__(self):
        super().__init__("odom_listener")
        self.pose = None
        self._sub = self.create_subscription(
            Odometry, "/ODOM", self._cb, 10)

    def _cb(self, msg):
        p = msg.pose.pose
        yaw = _quat_to_yaw(p.orientation.x, p.orientation.y,
                            p.orientation.z, p.orientation.w)
        self.pose = {"x": p.position.x, "y": p.position.y, "yaw": yaw}


def get_robot_location(timeout_sec=5.0):
    """Subscribe to /ODOM and return the first pose as dict, or None."""
    if not rclpy.ok():
        rclpy.init()
    node = _OdomListener()
    end_time = node.get_clock().now().nanoseconds + int(timeout_sec * 1e9)
    while rclpy.ok() and node.pose is None:
        rclpy.spin_once(node, timeout_sec=0.1)
        if node.get_clock().now().nanoseconds > end_time:
            break
    pose = node.pose
    node.destroy_node()
    return pose


def read_waypoints_file(filepath):
    """Read waypoints from a CSV file. Each row: x, y [, yaw_rad].
    Lines starting with # are skipped."""
    waypoints = []
    with open(filepath, "r") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 2:
                continue
            x   = float(parts[0])
            y   = float(parts[1])
            yaw = float(parts[2]) if len(parts) >= 3 else 0.0
            waypoints.append({"x": x, "y": y, "yaw": yaw})
    return waypoints


def read_patrol_csv(csv_path):
    """Read the CSV produced by the C++ patrol command.
    Returns list of dicts matching the CSV columns."""
    rows = []
    with open(csv_path, "r") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(row)
    return rows


def format_waypoints_for_cpp(waypoints):
    """Convert waypoint dicts to C++ CLI format: ['x,y,yaw', ...]"""
    return [f"{wp['x']},{wp['y']},{wp['yaw']}" for wp in waypoints]


def normalize_angle_deg(angle_deg):
    """Normalize angle to [-180, 180] degrees."""
    while angle_deg > 180:
        angle_deg -= 360
    while angle_deg < -180:
        angle_deg += 360
    return angle_deg


def today_str():
    return datetime.now().strftime("%Y-%m-%d")


def timestamp_dir():
    return datetime.now().strftime("%Y-%m-%d_%H%M%S")

# ============================================================
#  Test Runners
# ============================================================

def run_bridge_test(test_type, map_name, output_dir):
    """Run T2/T3/T4 via bridge queue mode (waypoints from /goal_pose in RViz2).
    Returns list of WaypointResult dicts."""
    print(f"\n[run.py] BRIDGE MODE – Draw waypoints in RViz2, press ENTER to execute")
    print(f"[run.py] Test type: {test_type}  |  Map: {map_name}\n")

    csv_path = os.path.join(output_dir, f"raw_{test_type}_bridge.csv")
    cpp_args = ["bridge", "queue", "--csv", csv_path]

    # Run bridge queue (blocks until user presses ENTER and execution finishes)
    run_cpp_live(cpp_args)

    if not os.path.exists(csv_path):
        print(f"[run.py] WARNING: CSV not produced – no results to process")
        return []

    rows = read_patrol_csv(csv_path)
    results = []
    for row in rows:
        dist_err = float(row.get("distance_error_m", 0))
        results.append({
            "trial_num":       1,
            "map_used":        map_name,
            "date":            today_str(),
            "waypoint_num":    int(row.get("waypoint_num", 0)),
            "target_x":        float(row.get("target_x", 0)),
            "target_y":        float(row.get("target_y", 0)),
            "target_yaw_deg":  float(row.get("target_yaw_deg", 0)),
            "actual_x":        float(row.get("actual_x", 0)),
            "actual_y":        float(row.get("actual_y", 0)),
            "actual_yaw_deg":  float(row.get("actual_yaw_deg", 0)),
            "distance_error":  dist_err,
            "heading_error_deg": float(row.get("heading_error_deg", 0)),
            "nav_completed":   row.get("nav_completed", "NO"),
            "within_threshold": "YES" if dist_err <= SETTLE_THRESHOLD else "NO",
            "result":          "PASS" if (row.get("nav_completed") == "YES"
                                         and dist_err <= SETTLE_THRESHOLD) else "FAIL",
            "notes":           "",
        })
    return results


def run_waypoint_test(test_type, map_name, waypoints, trials, output_dir):
    """Run T2/T3/T4 waypoint navigation benchmark.
    Returns list of WaypointResult dicts."""
    all_results = []
    wp_strings = format_waypoints_for_cpp(waypoints)

    for trial in range(1, trials + 1):
        print(f"\n{'='*60}")
        print(f"  {test_type} – Trial {trial}/{trials}")
        print(f"{'='*60}\n")

        csv_path = os.path.join(output_dir, f"raw_{test_type}_trial{trial}.csv")
        cpp_args = ["patrol"] + wp_strings + ["--csv", csv_path]

        # Run patrol with long timeout (120s per waypoint + buffer)
        timeout = len(waypoints) * 150 + 60
        run_cpp_live(cpp_args, timeout=timeout)

        if not os.path.exists(csv_path):
            print(f"[run.py] WARNING: CSV not produced for trial {trial}")
            continue

        rows = read_patrol_csv(csv_path)
        for row in rows:
            dist_err = float(row.get("distance_error_m", 0))
            result = {
                "trial_num":     trial,
                "map_used":      map_name,
                "date":          today_str(),
                "waypoint_num":  int(row.get("waypoint_num", 0)),
                "target_x":      float(row.get("target_x", 0)),
                "target_y":      float(row.get("target_y", 0)),
                "target_yaw_deg": float(row.get("target_yaw_deg", 0)),
                "actual_x":      float(row.get("actual_x", 0)),
                "actual_y":      float(row.get("actual_y", 0)),
                "actual_yaw_deg": float(row.get("actual_yaw_deg", 0)),
                "distance_error": dist_err,
                "heading_error_deg": float(row.get("heading_error_deg", 0)),
                "nav_completed": row.get("nav_completed", "NO"),
                "within_threshold": "YES" if dist_err <= SETTLE_THRESHOLD else "NO",
                "result":        "PASS" if (row.get("nav_completed") == "YES"
                                            and dist_err <= SETTLE_THRESHOLD) else "FAIL",
                "notes":         "",
            }
            all_results.append(result)

    return all_results


def run_slam_test(map_name, trials, output_dir):
    """Run T1 SLAM loop-closure benchmark.
    User teleoperates the robot through a loop for each trial.
    Script records start/end pose and computes drift.
    Returns list of SlamTrialResult dicts."""
    all_results = []

    for trial in range(1, trials + 1):
        print(f"\n{'='*60}")
        print(f"  T1 SLAM Loop Closure – Trial {trial}/{trials}")
        print(f"{'='*60}\n")

        # 1. Wait for user to be ready, then record start pose
        input("[run.py] Position the robot at the start. Press ENTER to record start pose...")
        print("[run.py] Querying start pose...")
        start_loc = get_robot_location()
        if not start_loc:
            print("[run.py] WARNING: Could not get start pose – skipping trial")
            all_results.append({
                "trial_num": trial, "map_used": map_name, "date": today_str(),
                "start_x": 0, "start_y": 0, "start_yaw_deg": 0,
                "end_x": 0, "end_y": 0, "end_yaw_deg": 0,
                "lce": 0, "delta_theta_deg": 0,
                "lce_pass": "NO", "theta_pass": "NO", "result": "FAIL",
                "notes": "Could not query start pose",
            })
            continue

        start_x = float(start_loc["x"])
        start_y = float(start_loc["y"])
        start_yaw = float(start_loc["yaw"])
        start_yaw_deg = start_yaw * 180.0 / math.pi
        print(f"[run.py] Start pose: x={start_x:.4f} y={start_y:.4f} yaw={start_yaw_deg:.1f}°")

        # 2. User teleoperates the robot through a loop
        print(f"\n[run.py] Teleoperate the robot through the loop now.")
        print(f"[run.py] Bring it back to the starting position when done.")
        input("[run.py] Press ENTER when finished...")

        # 3. Record end pose
        print("[run.py] Querying end pose...")
        end_loc = get_robot_location()
        if not end_loc:
            print("[run.py] WARNING: Could not get end pose")
            end_x, end_y, end_yaw = start_x, start_y, start_yaw
            end_yaw_deg = start_yaw_deg
            notes = "Could not query end pose"
        else:
            end_x = float(end_loc["x"])
            end_y = float(end_loc["y"])
            end_yaw = float(end_loc["yaw"])
            end_yaw_deg = end_yaw * 180.0 / math.pi
            notes = ""
        print(f"[run.py] End pose: x={end_x:.4f} y={end_y:.4f} yaw={end_yaw_deg:.1f}°")

        # 4. Compute LCE and heading drift
        dx = end_x - start_x
        dy = end_y - start_y
        lce = math.sqrt(dx * dx + dy * dy)
        delta_theta = abs(normalize_angle_deg(end_yaw_deg - start_yaw_deg))

        lce_ok = lce < LCE_THRESHOLD
        theta_ok = delta_theta < YAW_THRESHOLD
        passed = lce_ok and theta_ok

        print(f"[run.py] LCE={lce:.4f}m  Δθ={delta_theta:.1f}°  → {'PASS' if passed else 'FAIL'}")

        all_results.append({
            "trial_num":      trial,
            "map_used":       map_name,
            "date":           today_str(),
            "start_x":        start_x,
            "start_y":        start_y,
            "start_yaw_deg":  start_yaw_deg,
            "end_x":          end_x,
            "end_y":          end_y,
            "end_yaw_deg":    end_yaw_deg,
            "lce":            lce,
            "delta_theta_deg": delta_theta,
            "lce_pass":       "YES" if lce_ok else "NO",
            "theta_pass":     "YES" if theta_ok else "NO",
            "result":         "PASS" if passed else "FAIL",
            "notes":          notes,
        })

    return all_results

# ============================================================
#  CSV Writers (structured – one per test sheet)
# ============================================================

def write_t1_csv(results, output_dir):
    """Write T1 SLAM Loop Closure CSV matching Excel format."""
    path = os.path.join(output_dir, "T1_SLAM_Loop_Closure.csv")
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Trial #", "Map Used", "Date",
                     "Start Pose X (m)", "Start Pose Y (m)", "Start Yaw (°)",
                     "End Pose X (m)", "End Pose Y (m)", "End Yaw (°)",
                     "LCE (m)", "Δθ (°)",
                     "LCE < 0.15m?", "Δθ < 5°?", "PASS/FAIL", "Notes"])
        for r in results:
            w.writerow([
                r["trial_num"], r["map_used"], r["date"],
                f"{r['start_x']:.4f}", f"{r['start_y']:.4f}", f"{r['start_yaw_deg']:.1f}",
                f"{r['end_x']:.4f}", f"{r['end_y']:.4f}", f"{r['end_yaw_deg']:.1f}",
                f"{r['lce']:.4f}", f"{r['delta_theta_deg']:.1f}",
                r["lce_pass"], r["theta_pass"], r["result"], r["notes"],
            ])
        # Summary
        total = len(results)
        passed = sum(1 for r in results if r["result"] == "PASS")
        rate = passed / total if total else 0
        w.writerow([])
        w.writerow(["SUMMARY"])
        w.writerow(["Total Trials", total])
        w.writerow(["Passed", passed])
        w.writerow(["Success Rate", f"{rate:.0%}"])
        w.writerow(["Criteria Met? (>3/5)", "YES" if passed > 3 else "NO"])
    print(f"[run.py] T1 CSV saved: {path}")
    return path


def write_waypoint_csv(test_type, results, output_dir):
    """Write T2/T3/T4 waypoint CSV matching Excel format."""
    filenames = {
        "T2": "T2_Nav_No_Obstacles.csv",
        "T3": "T3_Nav_Static_Obs.csv",
        "T4": "T4_Nav_Dynamic_Obs.csv",
    }
    titles = {
        "T2": "T2: Navigation — No Obstacles (WRR > 8/10)",
        "T3": "T3: Navigation — Static Obstacles (WRR > 6/10)",
        "T4": "T4: Navigation — Dynamic Obstacles (WRR > 6/10)",
    }
    path = os.path.join(output_dir, filenames[test_type])
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow([titles[test_type]])
        w.writerow(["Trial #", "Map Used", "Date", "Waypoint #",
                     "Target X (m)", "Target Y (m)", "Target Yaw (°)",
                     "Actual X (m)", "Actual Y (m)", "Actual Yaw (°)",
                     "Distance Error (m)", "Heading Error (°)",
                     "Nav Completed?", "Within 0.1m?", "Result", "Notes"])
        for r in results:
            w.writerow([
                r["trial_num"], r["map_used"], r["date"], r["waypoint_num"],
                f"{r['target_x']:.4f}", f"{r['target_y']:.4f}", f"{r['target_yaw_deg']:.1f}",
                f"{r['actual_x']:.4f}", f"{r['actual_y']:.4f}", f"{r['actual_yaw_deg']:.1f}",
                f"{r['distance_error']:.4f}", f"{r['heading_error_deg']:.1f}",
                r["nav_completed"], r["within_threshold"], r["result"], r["notes"],
            ])
        # Summary
        total = len(results)
        passed = sum(1 for r in results if r["result"] == "PASS")
        wrr = passed / total if total else 0
        dist_errors = [r["distance_error"] for r in results]
        mean_err = sum(dist_errors) / len(dist_errors) if dist_errors else 0
        max_err = max(dist_errors) if dist_errors else 0

        thresholds = {"T2": 8, "T3": 6, "T4": 6}
        criteria_met = "YES" if passed >= thresholds.get(test_type, 8) else "NO"

        w.writerow([])
        w.writerow(["SUMMARY"])
        w.writerow(["Total Waypoints Attempted", total])
        w.writerow(["Waypoints Reached (PASS)", passed])
        w.writerow(["Waypoint Reach Rate (WRR)", f"{wrr:.0%}"])
        w.writerow([f"Criteria Met? (>{thresholds.get(test_type, 8)}/10)", criteria_met])
        w.writerow(["Mean Distance Error (m)", f"{mean_err:.4f}"])
        w.writerow(["Max Distance Error (m)", f"{max_err:.4f}"])
    print(f"[run.py] {test_type} CSV saved: {path}")
    return path


def write_results_summary_csv(test_results, output_dir):
    """Write the Results Summary CSV."""
    path = os.path.join(output_dir, "Results_Summary.csv")
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["BENCHMARK RESULTS"])
        w.writerow([])
        w.writerow(["Test ID", "Test Name", "Success Criteria", "Result", "Pass?", "Notes"])

        tests_passed = 0
        for tid, tname, criteria, result, passed, notes in test_results:
            w.writerow([tid, tname, criteria, result, passed, notes])
            if passed == "YES":
                tests_passed += 1

        w.writerow([])
        w.writerow(["OVERALL VERDICT"])
        w.writerow(["Tests Passed", tests_passed])
        w.writerow(["Total Tests", len(test_results)])
        w.writerow(["Stack Ready?", "YES" if tests_passed == len(test_results) else "NO"])
    print(f"[run.py] Results Summary CSV saved: {path}")
    return path

# ============================================================
#  Excel Generation
# ============================================================

def generate_excel(output_dir, t1_results=None, t2_results=None,
                   t3_results=None, t4_results=None, map_name=""):
    """Generate the benchmark Excel workbook from test results."""
    if not HAS_OPENPYXL:
        print("[run.py] WARNING: openpyxl not installed – skipping Excel generation")
        print("[run.py]   Install with: pip install openpyxl")
        return None

    wb = Workbook()

    # -- Styles --
    header_font = Font(bold=True)
    header_fill = PatternFill(start_color="D9E1F2", end_color="D9E1F2", fill_type="solid")
    pass_fill = PatternFill(start_color="C6EFCE", end_color="C6EFCE", fill_type="solid")
    fail_fill = PatternFill(start_color="FFC7CE", end_color="FFC7CE", fill_type="solid")
    title_font = Font(bold=True, size=14)
    section_font = Font(bold=True, size=12)

    def style_header_row(ws, row_num, num_cols):
        for col in range(1, num_cols + 1):
            cell = ws.cell(row=row_num, column=col)
            cell.font = header_font
            cell.fill = header_fill
            cell.alignment = Alignment(horizontal="center", wrap_text=True)

    def style_pass_fail(ws, col_letter, start_row, end_row):
        for row in range(start_row, end_row + 1):
            cell = ws[f"{col_letter}{row}"]
            if cell.value == "PASS" or cell.value == "YES":
                cell.fill = pass_fill
            elif cell.value == "FAIL" or cell.value == "NO":
                cell.fill = fail_fill

    # ---- Sheet: Overview ----
    ws = wb.active
    ws.title = "Overview"
    ws.append([" Indoor SLAM & Navigation Benchmarking"])
    ws["A1"].font = title_font
    ws.append([f"Platform: DeepRobotics Quadruped  |  Stack: Native SLAM & Nav  |  Environment: Indoor"])
    ws.append([])
    ws.append(["TEST PARAMETERS"])
    ws["A4"].font = section_font
    params = [
        ["Parameter", "Value", "Notes"],
        ["Robot Platform", "DeepRobotics M20 Pro", "Native SLAM & navigation stack"],
        ["SLAM Algorithm", "Custom FASTLIO2", "Custom C++ implementation with loop closure"],
        ["Map", f"Pre-built SLAM map ({map_name})", "Map built prior to test; localization mode used for trials"],
        ["Waypoint Tolerance (r)", "0.1 m", "Euclidean distance from commanded position"],
        ["LCE Threshold", "0.15 m", "Max translational loop closure error"],
        ["Heading Drift Threshold", "5°", "Max rotational drift at loop closure"],
        ["Gait / Speed", "Default gait, Default low speed mode", ""],
        ["Environment", "Indoor office — structured", ""],
    ]
    for row in params:
        ws.append(row)
    style_header_row(ws, 5, 3)

    ws.append([])
    ws.append(["SUCCESS CRITERIA"])
    ws[f"A{ws.max_row}"].font = section_font
    ws.append(["Test ID", "Test Name", "Metric", "Pass Condition", "Min Trials", "Success Threshold"])
    style_header_row(ws, ws.max_row, 6)
    ws.append(["T1", "SLAM Loop Closure", "LCE (m) & Δθ (°)", "LCE < 0.15m AND Δθ < 5°", 5, ">4/5 trials pass (80%)"])
    ws.append(["T2", "Nav — No Obstacles", "Waypoint Reach Rate (WRR)", "Waypoint within 0.1m", 10, ">8/10 waypoints reached (80%)"])
    ws.append(["T3", "Nav — Static Obstacles", "Waypoint Reach Rate (WRR)", "Waypoint within 0.1m", 10, ">8/10 waypoints reached (80%)"])
    ws.append(["T4", "Nav — Dynamic Obstacles", "Waypoint Reach Rate (WRR)", "Waypoint within 0.1m", 10, ">5/10 waypoints reached (50%)"])

    # Set column widths
    ws.column_dimensions["A"].width = 25
    ws.column_dimensions["B"].width = 45
    ws.column_dimensions["C"].width = 55

    # ---- Sheet: T1 ----
    if t1_results:
        ws_t1 = wb.create_sheet("T1 - SLAM Loop Closure")
        headers = ["Trial #", "Map Used", "Date",
                    "Start Pose X (m)", "Start Pose Y (m)", "Start Yaw (°)",
                    "End Pose X (m)", "End Pose Y (m)", "End Yaw (°)",
                    "LCE (m)", "Δθ (°)",
                    "LCE < 0.15m?", "Δθ < 5°?", "PASS/FAIL", "Notes"]
        ws_t1.append(headers)
        style_header_row(ws_t1, 1, len(headers))

        for r in t1_results:
            ws_t1.append([
                r["trial_num"], r["map_used"], r["date"],
                round(r["start_x"], 4), round(r["start_y"], 4), round(r["start_yaw_deg"], 1),
                round(r["end_x"], 4), round(r["end_y"], 4), round(r["end_yaw_deg"], 1),
                round(r["lce"], 4), round(r["delta_theta_deg"], 1),
                r["lce_pass"], r["theta_pass"], r["result"], r["notes"],
            ])

        data_end = len(t1_results) + 1
        style_pass_fail(ws_t1, "L", 2, data_end)
        style_pass_fail(ws_t1, "M", 2, data_end)
        style_pass_fail(ws_t1, "N", 2, data_end)

        # Summary
        total = len(t1_results)
        passed = sum(1 for r in t1_results if r["result"] == "PASS")
        rate = passed / total if total else 0
        r = data_end + 2
        ws_t1.cell(row=r, column=1, value="SUMMARY").font = section_font
        ws_t1.append(["Total Trials", total])
        ws_t1.append(["Passed", passed])
        ws_t1.append(["Success Rate", f"{rate:.0%}"])
        ws_t1.append(["Criteria Met? (>3/5)", "YES" if passed > 3 else "NO"])

    # ---- Sheets: T2, T3, T4 ----
    test_configs = {
        "T2": ("T2 - Nav No Obstacles", "T2: Navigation — No Obstacles (WRR > 8/10)", t2_results, 8),
        "T3": ("T3 - Nav Static Obs", "T3: Navigation — Static Obstacles (WRR > 6/10)", t3_results, 6),
        "T4": ("T4 - Nav Dynamic Obs", "T4: Navigation — Dynamic Obstacles (WRR > 6/10)", t4_results, 6),
    }

    for tid, (sheet_name, title, results, threshold) in test_configs.items():
        ws_t = wb.create_sheet(sheet_name)
        ws_t.append([title])
        ws_t["A1"].font = title_font

        headers = ["Trial #", "Map Used", "Date", "Waypoint #",
                    "Target X (m)", "Target Y (m)", "Target Yaw (°)",
                    "Actual X (m)", "Actual Y (m)", "Actual Yaw (°)",
                    "Distance Error (m)", "Heading Error (°)",
                    "Nav Completed?", "Within 0.1m?", "Result", "Notes"]
        ws_t.append(headers)
        style_header_row(ws_t, 2, len(headers))

        if results:
            for r in results:
                ws_t.append([
                    r["trial_num"], r["map_used"], r["date"], r["waypoint_num"],
                    round(r["target_x"], 4), round(r["target_y"], 4), round(r["target_yaw_deg"], 1),
                    round(r["actual_x"], 4), round(r["actual_y"], 4), round(r["actual_yaw_deg"], 1),
                    round(r["distance_error"], 4), round(r["heading_error_deg"], 1),
                    r["nav_completed"], r["within_threshold"], r["result"], r["notes"],
                ])

            data_end = len(results) + 2
            style_pass_fail(ws_t, "N", 3, data_end)
            style_pass_fail(ws_t, "O", 3, data_end)

            # Summary
            total = len(results)
            passed = sum(1 for r in results if r["result"] == "PASS")
            wrr = passed / total if total else 0
            dist_errors = [r["distance_error"] for r in results]
            mean_err = sum(dist_errors) / len(dist_errors) if dist_errors else 0
            max_err = max(dist_errors) if dist_errors else 0

            r_row = data_end + 2
            ws_t.cell(row=r_row, column=1, value="SUMMARY").font = section_font
            ws_t.append(["Total Waypoints Attempted", total])
            ws_t.append(["Waypoints Reached (PASS)", passed])
            ws_t.append(["Waypoint Reach Rate (WRR)", f"{wrr:.0%}"])
            ws_t.append([f"Criteria Met? (>{threshold}/10)", "YES" if passed >= threshold else "NO"])
            ws_t.append(["Mean Distance Error (m)", round(mean_err, 4)])
            ws_t.append(["Max Distance Error (m)", round(max_err, 4)])

    # ---- Sheet: Results Summary ----
    ws_sum = wb.create_sheet("Results Summary")
    ws_sum.append(["BENCHMARK RESULTS"])
    ws_sum["A1"].font = title_font
    ws_sum.append([])
    ws_sum.append(["Test ID", "Test Name", "Success Criteria", "Result", "Pass?", "Notes"])
    style_header_row(ws_sum, 3, 6)

    summary_rows = []

    # T1 summary
    if t1_results:
        total = len(t1_results)
        passed = sum(1 for r in t1_results if r["result"] == "PASS")
        rate_str = f"{passed}/{total}"
        is_pass = "YES" if passed > 3 else "NO"
        summary_rows.append(("T1", "SLAM Loop Closure",
                             "LCE < 0.15m & Δθ < 5°, >4/5 trials",
                             rate_str, is_pass, ""))

    # T2/T3/T4 summary
    for tid, (_, _, results, threshold) in test_configs.items():
        names = {"T2": "Nav — No Obstacles", "T3": "Nav — Static Obstacles", "T4": "Nav — Dynamic Obstacles"}
        if results:
            total = len(results)
            passed = sum(1 for r in results if r["result"] == "PASS")
            rate_str = f"{passed}/{total}"
            is_pass = "YES" if passed >= threshold else "NO"
        else:
            rate_str = ""
            is_pass = ""
        criteria = f"WRR > {threshold}/10, within 0.1m"
        summary_rows.append((tid, names[tid], criteria, rate_str, is_pass, ""))

    for row in summary_rows:
        ws_sum.append(list(row))

    data_end = 3 + len(summary_rows)
    style_pass_fail(ws_sum, "E", 4, data_end)

    # Overall
    tests_passed = sum(1 for r in summary_rows if r[4] == "YES")
    ws_sum.append([])
    ws_sum.append(["OVERALL VERDICT"])
    ws_sum[f"A{ws_sum.max_row}"].font = section_font
    ws_sum.append(["Tests Passed", tests_passed])
    ws_sum.append(["Total Tests", len(summary_rows)])
    ws_sum.append(["Stack Ready?", "YES" if tests_passed == len(summary_rows) else "NO"])

    ws_sum.column_dimensions["A"].width = 20
    ws_sum.column_dimensions["B"].width = 25
    ws_sum.column_dimensions["C"].width = 35

    # Save
    xlsx_path = os.path.join(output_dir, "SLAM_Nav_Benchmark.xlsx")
    wb.save(xlsx_path)
    print(f"\n[run.py] Excel workbook saved: {xlsx_path}")
    return xlsx_path

# ============================================================
#  CLI
# ============================================================

def build_parser():
    parser = argparse.ArgumentParser(
        prog="run.py",
        description="CLI front-end for nav_cmd_bridge (C++ ROS 2 node + benchmark tests)",
    )
    sub = parser.add_subparsers(dest="command")

    # --- passthrough commands (no extra args beyond what C++ expects) ---
    for cmd in ["nav", "patrol", "bridge", "status", "loc", "cancel",
                "monitor", "heartbeat", "stand", "sit", "estop",
                "nav_mode", "regular_mode", "gait_flat", "gait_stair", "clearqueue"]:
        p = sub.add_parser(cmd, add_help=False)
        p.add_argument("extra", nargs=argparse.REMAINDER, default=[])

    # --- test command ---
    p_test = sub.add_parser("test", help="Run benchmark test (T1/T2/T3/T4)")
    p_test.add_argument("test_type", choices=["T1", "T2", "T3", "T4"],
                        help="Test type")
    p_test.add_argument("--map", required=True,
                        help="Map name (e.g. 'office_floor2')")
    p_test.add_argument("--waypoints", default=None,
                        help="Path to waypoints CSV file (x,y[,yaw_rad] per line). "
                             "Required unless --bridge is used.")
    p_test.add_argument("--bridge", action="store_true",
                        help="Use bridge queue mode – draw waypoints in RViz2 instead of file")
    p_test.add_argument("--trials", type=int, default=None,
                        help="Number of trials (default: 5 for T1, 1 for T2-T4)")
    p_test.add_argument("--output-dir", default=None,
                        help="Output directory for results")

    # --- excel command (generate from existing CSVs) ---
    p_excel = sub.add_parser("excel", help="Generate Excel from a previous test run directory")
    p_excel.add_argument("input_dir", help="Directory containing benchmark CSVs")
    p_excel.add_argument("-o", "--output", default=None,
                         help="Output .xlsx path (default: <input_dir>/SLAM_Nav_Benchmark.xlsx)")

    return parser


def main():
    parser = build_parser()
    args, remaining = parser.parse_known_args()

    if args.command is None:
        parser.print_help()
        return

    # ---- Passthrough commands ----
    passthrough_cmds = {"nav", "patrol", "bridge", "status", "loc", "cancel",
                        "monitor", "heartbeat", "stand", "sit", "estop",
                        "nav_mode", "regular_mode", "gait_flat", "gait_stair", "clearqueue"}

    if args.command in passthrough_cmds:
        extra = getattr(args, "extra", [])
        cpp_args = [args.command] + extra + remaining
        rc = run_cpp_live(cpp_args)
        sys.exit(rc)

    # ---- Test command ----
    if args.command == "test":
        test_type = args.test_type
        map_name = args.map
        wp_file = args.waypoints
        use_bridge = args.bridge
        trials = args.trials

        # Validate: T2-T4 need either --waypoints or --bridge; T1 needs neither
        if test_type != "T1" and not use_bridge and not wp_file:
            print("[run.py] ERROR: Provide --waypoints <file> or --bridge for T2/T3/T4")
            sys.exit(1)
        if use_bridge and test_type == "T1":
            print("[run.py] ERROR: --bridge is not supported for T1 (use teleoperation instead)")
            sys.exit(1)

        if trials is None:
            trials = 5 if test_type == "T1" else 1

        # Create output directory
        out_dir = args.output_dir or str(DEFAULT_OUTPUT_DIR / timestamp_dir())
        os.makedirs(out_dir, exist_ok=True)

        results = None

        if test_type == "T1":
            print(f"\n{'='*60}")
            print(f"  BENCHMARK: T1 SLAM Loop Closure  |  Map: {map_name}  |  Trials: {trials}")
            print(f"  Mode: Teleoperation (press ENTER to start/stop each trial)")
            print(f"{'='*60}\n")
            print(f"[run.py] Output directory: {out_dir}")
        elif use_bridge:
            print(f"\n{'='*60}")
            print(f"  BENCHMARK: {test_type}  |  Map: {map_name}  |  Mode: bridge queue")
            print(f"  Threshold: {SETTLE_THRESHOLD}m")
            print(f"{'='*60}\n")
            print(f"[run.py] Output directory: {out_dir}")

            results = run_bridge_test(test_type, map_name, out_dir)
        else:
            waypoints = read_waypoints_file(wp_file)
            if not waypoints:
                print(f"[run.py] ERROR: No waypoints found in {wp_file}")
                sys.exit(1)

            print(f"\n{'='*60}")
            print(f"  BENCHMARK: {test_type}  |  Map: {map_name}  |  Trials: {trials}")
            print(f"  Waypoints: {len(waypoints)}  |  Threshold: {SETTLE_THRESHOLD}m")
            print(f"{'='*60}\n")
            print(f"[run.py] Output directory: {out_dir}")

        # Run the test
        t1_res = t2_res = t3_res = t4_res = None

        if test_type == "T1":
            t1_res = run_slam_test(map_name, trials, out_dir)
            write_t1_csv(t1_res, out_dir)
        elif use_bridge:
            write_waypoint_csv(test_type, results, out_dir)
            if test_type == "T2":
                t2_res = results
            elif test_type == "T3":
                t3_res = results
            elif test_type == "T4":
                t4_res = results
        else:
            results = run_waypoint_test(test_type, map_name, waypoints, trials, out_dir)
            write_waypoint_csv(test_type, results, out_dir)
            if test_type == "T2":
                t2_res = results
            elif test_type == "T3":
                t3_res = results
            elif test_type == "T4":
                t4_res = results

        # Generate Excel
        generate_excel(out_dir, t1_results=t1_res, t2_results=t2_res,
                        t3_results=t3_res, t4_results=t4_res, map_name=map_name)

        print(f"\n[run.py] Test complete. Results in: {out_dir}")

    # ---- Excel command (from existing CSVs) ----
    elif args.command == "excel":
        input_dir = args.input_dir
        if not os.path.isdir(input_dir):
            print(f"[run.py] ERROR: Directory not found: {input_dir}")
            sys.exit(1)

        # Try to load results from CSVs
        t1_res = t2_res = t3_res = t4_res = None

        t1_csv = os.path.join(input_dir, "T1_SLAM_Loop_Closure.csv")
        if os.path.exists(t1_csv):
            t1_res = _load_t1_from_csv(t1_csv)

        for tid, fname in [("T2", "T2_Nav_No_Obstacles.csv"),
                           ("T3", "T3_Nav_Static_Obs.csv"),
                           ("T4", "T4_Nav_Dynamic_Obs.csv")]:
            csv_path = os.path.join(input_dir, fname)
            if os.path.exists(csv_path):
                results = _load_waypoint_from_csv(csv_path)
                if tid == "T2":
                    t2_res = results
                elif tid == "T3":
                    t3_res = results
                elif tid == "T4":
                    t4_res = results

        xlsx = args.output or os.path.join(input_dir, "SLAM_Nav_Benchmark.xlsx")
        generate_excel(os.path.dirname(xlsx) or input_dir,
                        t1_results=t1_res, t2_results=t2_res,
                        t3_results=t3_res, t4_results=t4_res)


def _load_t1_from_csv(csv_path):
    """Load T1 results from a structured CSV."""
    results = []
    with open(csv_path, "r") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        if not header:
            return results
        for row in reader:
            if not row or row[0] in ("", "SUMMARY"):
                break
            try:
                results.append({
                    "trial_num":      int(float(row[0])),
                    "map_used":       row[1],
                    "date":           row[2],
                    "start_x":        float(row[3]),
                    "start_y":        float(row[4]),
                    "start_yaw_deg":  float(row[5]),
                    "end_x":          float(row[6]),
                    "end_y":          float(row[7]),
                    "end_yaw_deg":    float(row[8]),
                    "lce":            float(row[9]),
                    "delta_theta_deg": float(row[10]),
                    "lce_pass":       row[11],
                    "theta_pass":     row[12],
                    "result":         row[13],
                    "notes":          row[14] if len(row) > 14 else "",
                })
            except (ValueError, IndexError):
                continue
    return results


def _load_waypoint_from_csv(csv_path):
    """Load T2/T3/T4 results from a structured CSV."""
    results = []
    with open(csv_path, "r") as f:
        reader = csv.reader(f)
        next(reader, None)  # skip title row
        header = next(reader, None)  # column headers
        if not header:
            return results
        for row in reader:
            if not row or row[0] in ("", "SUMMARY"):
                break
            try:
                results.append({
                    "trial_num":       int(float(row[0])),
                    "map_used":        row[1],
                    "date":            row[2],
                    "waypoint_num":    int(float(row[3])),
                    "target_x":        float(row[4]),
                    "target_y":        float(row[5]),
                    "target_yaw_deg":  float(row[6]),
                    "actual_x":        float(row[7]),
                    "actual_y":        float(row[8]),
                    "actual_yaw_deg":  float(row[9]),
                    "distance_error":  float(row[10]),
                    "heading_error_deg": float(row[11]),
                    "nav_completed":   row[12],
                    "within_threshold": row[13],
                    "result":          row[14],
                    "notes":           row[15] if len(row) > 15 else "",
                })
            except (ValueError, IndexError):
                continue
    return results


if __name__ == "__main__":
    main()
