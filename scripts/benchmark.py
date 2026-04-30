#!/usr/bin/env python3
"""benchmark.py — T1–T4 navigation benchmark for nav_cmd_bridge"""

import argparse
import csv
import math
import os
import subprocess
import sys
import threading
from datetime import datetime
from pathlib import Path

import rclpy
from rclpy.node import Node
from nav_msgs.msg import Odometry
from geometry_msgs.msg import PoseStamped

try:
    from openpyxl import Workbook
    from openpyxl.styles import Font, Alignment, PatternFill
    HAS_OPENPYXL = True
except ImportError:
    HAS_OPENPYXL = False

SETTLE_THRESHOLD = 0.1
LCE_THRESHOLD    = 0.15
YAW_THRESHOLD    = 5.0

_SCRIPT_DIR = Path(__file__).resolve().parent
_CPP_BIN_NAME = "nav_cmd_bridge"
_BIN_SEARCH_PATHS = [
    _SCRIPT_DIR / _CPP_BIN_NAME,
    _SCRIPT_DIR.parent / "build" / _CPP_BIN_NAME,
    Path.home() / "colcon_ws" / "install" / "nav_cmd_bridge" / "lib" / "nav_cmd_bridge" / _CPP_BIN_NAME,
]
_PROJECT_ROOT = _SCRIPT_DIR.parent
DEFAULT_OUTPUT_DIR = _PROJECT_ROOT / "assets" / "outputs"


def find_cpp_binary():
    import shutil, stat
    hit = shutil.which(_CPP_BIN_NAME)
    if hit:
        return hit
    for p in _BIN_SEARCH_PATHS:
        if p.exists():
            if not os.access(str(p), os.X_OK):
                try:
                    st = os.stat(str(p))
                    os.chmod(str(p), st.st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
                except PermissionError:
                    print(f"[benchmark] WARNING: {p} not executable and chmod failed", file=sys.stderr)
            return str(p)
    return _CPP_BIN_NAME


def run_cpp_live(args, timeout=None):
    binary = find_cpp_binary()
    cmd = [binary] + args
    print(f"[benchmark] {' '.join(cmd)}")
    try:
        return subprocess.call(cmd, timeout=timeout)
    except subprocess.TimeoutExpired:
        print("[benchmark] Command timed out", file=sys.stderr)
        return -1


def _quat_to_yaw(x, y, z, w):
    return math.atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z))


class _OdomListener(Node):
    def __init__(self):
        super().__init__("odom_listener")
        self.pose = None
        self._sub = self.create_subscription(Odometry, "/ODOM", self._cb, 10)

    def _cb(self, msg):
        p = msg.pose.pose
        self.pose = {
            "x":   p.position.x,
            "y":   p.position.y,
            "yaw": _quat_to_yaw(p.orientation.x, p.orientation.y,
                                 p.orientation.z, p.orientation.w),
        }


class _GoalPoseCollector(Node):
    def __init__(self):
        super().__init__("wp_collector")
        self.waypoints = []
        self._sub = self.create_subscription(PoseStamped, "/goal_pose", self._cb, 10)

    def _cb(self, msg):
        yaw = _quat_to_yaw(msg.pose.orientation.x, msg.pose.orientation.y,
                            msg.pose.orientation.z, msg.pose.orientation.w)
        wp = {"x": msg.pose.position.x, "y": msg.pose.position.y, "yaw": yaw}
        self.waypoints.append(wp)
        print(f"[benchmark] Queued WP {len(self.waypoints)}: x={wp['x']:.3f} y={wp['y']:.3f} yaw={math.degrees(yaw):.1f}deg")


def get_robot_location(timeout_sec=5.0):
    if not rclpy.ok():
        rclpy.init()
    node = _OdomListener()
    end = node.get_clock().now().nanoseconds + int(timeout_sec * 1e9)
    while rclpy.ok() and node.pose is None:
        rclpy.spin_once(node, timeout_sec=0.1)
        if node.get_clock().now().nanoseconds > end:
            break
    pose = node.pose
    node.destroy_node()
    return pose


def collect_bridge_waypoints():
    if not rclpy.ok():
        rclpy.init()
    node = _GoalPoseCollector()
    spin_thread = threading.Thread(target=lambda: rclpy.spin(node), daemon=True)
    spin_thread.start()
    input("\n[benchmark] Draw waypoints in RViz2, then press ENTER when done...\n")
    waypoints = list(node.waypoints)
    node.destroy_node()
    return waypoints


def read_waypoints_file(filepath):
    waypoints = []
    with open(filepath) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 2:
                continue
            waypoints.append({
                "x":   float(parts[0]),
                "y":   float(parts[1]),
                "yaw": float(parts[2]) if len(parts) >= 3 else 0.0,
            })
    return waypoints


def today_str():
    return datetime.now().strftime("%Y-%m-%d")


def timestamp_dir():
    return datetime.now().strftime("%Y-%m-%d_%H%M%S")


def normalize_angle_deg(a):
    while a >  180: a -= 360
    while a < -180: a += 360
    return a


def run_slam_test(map_name, trials, output_dir):
    all_results = []
    for trial in range(1, trials + 1):
        print(f"\n{'='*60}\n  T1 SLAM Loop Closure — Trial {trial}/{trials}\n{'='*60}\n")
        input("[benchmark] Position robot at start, press ENTER to record start pose...")
        start = get_robot_location()
        if not start:
            print("[benchmark] WARNING: Could not read start pose — skipping trial")
            all_results.append({
                "trial_num": trial, "map_used": map_name, "date": today_str(),
                "start_x": 0, "start_y": 0, "start_yaw_deg": 0,
                "end_x": 0, "end_y": 0, "end_yaw_deg": 0,
                "lce": 0, "delta_theta_deg": 0,
                "lce_pass": "NO", "theta_pass": "NO", "result": "FAIL",
                "notes": "Could not query start pose",
            })
            continue

        sx, sy = float(start["x"]), float(start["y"])
        syaw_deg = math.degrees(float(start["yaw"]))
        print(f"[benchmark] Start: x={sx:.4f} y={sy:.4f} yaw={syaw_deg:.1f}deg")

        print("\n[benchmark] Teleoperate the robot through the loop.")
        input("[benchmark] Press ENTER when back at start position...")

        end = get_robot_location()
        if not end:
            print("[benchmark] WARNING: Could not read end pose")
            ex, ey, eyaw_deg = sx, sy, syaw_deg
            notes = "Could not query end pose"
        else:
            ex, ey = float(end["x"]), float(end["y"])
            eyaw_deg = math.degrees(float(end["yaw"]))
            notes = ""
        print(f"[benchmark] End:   x={ex:.4f} y={ey:.4f} yaw={eyaw_deg:.1f}deg")

        lce = math.sqrt((ex - sx) ** 2 + (ey - sy) ** 2)
        dtheta = abs(normalize_angle_deg(eyaw_deg - syaw_deg))
        lce_ok = lce < LCE_THRESHOLD
        theta_ok = dtheta < YAW_THRESHOLD
        passed = lce_ok and theta_ok
        print(f"[benchmark] LCE={lce:.4f}m  Δθ={dtheta:.1f}deg  → {'PASS' if passed else 'FAIL'}")

        all_results.append({
            "trial_num":      trial,
            "map_used":       map_name,
            "date":           today_str(),
            "start_x":        sx,
            "start_y":        sy,
            "start_yaw_deg":  syaw_deg,
            "end_x":          ex,
            "end_y":          ey,
            "end_yaw_deg":    eyaw_deg,
            "lce":            lce,
            "delta_theta_deg": dtheta,
            "lce_pass":       "YES" if lce_ok else "NO",
            "theta_pass":     "YES" if theta_ok else "NO",
            "result":         "PASS" if passed else "FAIL",
            "notes":          notes,
        })
    return all_results


def run_waypoint_test(test_type, map_name, waypoints, trials, output_dir, robot_ip):
    all_results = []
    for trial in range(1, trials + 1):
        print(f"\n{'='*60}\n  {test_type} — Trial {trial}/{trials}\n{'='*60}")
        for i, wp in enumerate(waypoints):
            wp_num = i + 1
            print(f"\n[benchmark] WP {wp_num}/{len(waypoints)}: target x={wp['x']:.4f} y={wp['y']:.4f}")
            run_cpp_live(["patrol", f"{wp['x']},{wp['y']},{wp['yaw']}", "--ip", robot_ip],
                         timeout=150)
            actual = get_robot_location()
            if actual is None:
                print(f"[benchmark] WARNING: ODOM unavailable for WP {wp_num}")
                actual = {"x": wp["x"], "y": wp["y"], "yaw": wp["yaw"]}
                nav_done = False
            else:
                dx = actual["x"] - wp["x"]
                dy = actual["y"] - wp["y"]
                nav_done = math.sqrt(dx * dx + dy * dy) <= SETTLE_THRESHOLD

            dx = actual["x"] - wp["x"]
            dy = actual["y"] - wp["y"]
            dist = math.sqrt(dx * dx + dy * dy)
            dyaw = actual["yaw"] - wp["yaw"]
            while dyaw >  math.pi: dyaw -= 2 * math.pi
            while dyaw < -math.pi: dyaw += 2 * math.pi
            heading_err = abs(math.degrees(dyaw))
            passed = nav_done and dist <= SETTLE_THRESHOLD

            all_results.append({
                "trial_num":         trial,
                "map_used":          map_name,
                "date":              today_str(),
                "waypoint_num":      wp_num,
                "target_x":          wp["x"],
                "target_y":          wp["y"],
                "target_yaw_deg":    math.degrees(wp["yaw"]),
                "actual_x":          actual["x"],
                "actual_y":          actual["y"],
                "actual_yaw_deg":    math.degrees(actual["yaw"]),
                "distance_error":    dist,
                "heading_error_deg": heading_err,
                "nav_completed":     "YES" if nav_done else "NO",
                "within_threshold":  "YES" if dist <= SETTLE_THRESHOLD else "NO",
                "result":            "PASS" if passed else "FAIL",
                "notes":             "",
            })
    return all_results


def write_t1_csv(results, output_dir):
    path = os.path.join(output_dir, "T1_SLAM_Loop_Closure.csv")
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Trial #", "Map Used", "Date",
                    "Start X (m)", "Start Y (m)", "Start Yaw (deg)",
                    "End X (m)", "End Y (m)", "End Yaw (deg)",
                    "LCE (m)", "Δθ (deg)", "LCE < 0.15m?", "Δθ < 5deg?", "PASS/FAIL", "Notes"])
        for r in results:
            w.writerow([
                r["trial_num"], r["map_used"], r["date"],
                f"{r['start_x']:.4f}", f"{r['start_y']:.4f}", f"{r['start_yaw_deg']:.1f}",
                f"{r['end_x']:.4f}", f"{r['end_y']:.4f}", f"{r['end_yaw_deg']:.1f}",
                f"{r['lce']:.4f}", f"{r['delta_theta_deg']:.1f}",
                r["lce_pass"], r["theta_pass"], r["result"], r["notes"],
            ])
        total = len(results)
        passed = sum(1 for r in results if r["result"] == "PASS")
        w.writerow([])
        w.writerow(["SUMMARY"])
        w.writerow(["Total Trials", total])
        w.writerow(["Passed", passed])
        w.writerow(["Success Rate", f"{passed/total:.0%}" if total else "0%"])
        w.writerow(["Criteria Met? (>4/5)", "YES" if passed > 3 else "NO"])
    print(f"[benchmark] T1 CSV: {path}")
    return path


def write_waypoint_csv(test_type, results, output_dir):
    filenames = {"T2": "T2_Nav_No_Obstacles.csv",
                 "T3": "T3_Nav_Static_Obs.csv",
                 "T4": "T4_Nav_Dynamic_Obs.csv"}
    titles = {"T2": "T2: Navigation — No Obstacles (WRR > 8/10)",
              "T3": "T3: Navigation — Static Obstacles (WRR > 6/10)",
              "T4": "T4: Navigation — Dynamic Obstacles (WRR > 6/10)"}
    path = os.path.join(output_dir, filenames[test_type])
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow([titles[test_type]])
        w.writerow(["Trial #", "Map Used", "Date", "WP #",
                    "Target X (m)", "Target Y (m)", "Target Yaw (deg)",
                    "Actual X (m)", "Actual Y (m)", "Actual Yaw (deg)",
                    "Dist Error (m)", "Heading Error (deg)",
                    "Nav Completed?", "Within 0.1m?", "Result", "Notes"])
        for r in results:
            w.writerow([
                r["trial_num"], r["map_used"], r["date"], r["waypoint_num"],
                f"{r['target_x']:.4f}", f"{r['target_y']:.4f}", f"{r['target_yaw_deg']:.1f}",
                f"{r['actual_x']:.4f}", f"{r['actual_y']:.4f}", f"{r['actual_yaw_deg']:.1f}",
                f"{r['distance_error']:.4f}", f"{r['heading_error_deg']:.1f}",
                r["nav_completed"], r["within_threshold"], r["result"], r["notes"],
            ])
        total = len(results)
        passed = sum(1 for r in results if r["result"] == "PASS")
        errs = [r["distance_error"] for r in results]
        thresholds = {"T2": 8, "T3": 6, "T4": 6}
        thr = thresholds.get(test_type, 8)
        w.writerow([])
        w.writerow(["SUMMARY"])
        w.writerow(["Total Waypoints", total])
        w.writerow(["Passed", passed])
        w.writerow(["WRR", f"{passed/total:.0%}" if total else "0%"])
        w.writerow([f"Criteria Met? (>{thr}/10)", "YES" if passed >= thr else "NO"])
        w.writerow(["Mean Dist Error (m)", f"{sum(errs)/len(errs):.4f}" if errs else "0"])
        w.writerow(["Max Dist Error (m)", f"{max(errs):.4f}" if errs else "0"])
    print(f"[benchmark] {test_type} CSV: {path}")
    return path


def generate_excel(output_dir, t1_results=None, t2_results=None,
                   t3_results=None, t4_results=None, map_name=""):
    if not HAS_OPENPYXL:
        print("[benchmark] openpyxl not installed — skipping Excel (pip install openpyxl)")
        return None

    wb = Workbook()
    hdr_font  = Font(bold=True)
    hdr_fill  = PatternFill(start_color="D9E1F2", end_color="D9E1F2", fill_type="solid")
    pass_fill = PatternFill(start_color="C6EFCE", end_color="C6EFCE", fill_type="solid")
    fail_fill = PatternFill(start_color="FFC7CE", end_color="FFC7CE", fill_type="solid")
    title_font = Font(bold=True, size=14)

    def style_headers(ws, row, ncols):
        for c in range(1, ncols + 1):
            cell = ws.cell(row=row, column=c)
            cell.font = hdr_font
            cell.fill = hdr_fill
            cell.alignment = Alignment(horizontal="center", wrap_text=True)

    def color_pass_fail(ws, col, r_start, r_end):
        for r in range(r_start, r_end + 1):
            cell = ws.cell(row=r, column=col)
            if cell.value in ("PASS", "YES"):
                cell.fill = pass_fill
            elif cell.value in ("FAIL", "NO"):
                cell.fill = fail_fill

    ws = wb.active
    ws.title = "Overview"
    ws.append(["Indoor SLAM & Navigation Benchmarking"])
    ws["A1"].font = title_font
    ws.append([f"Platform: DeepRobotics M20 Pro  |  Map: {map_name}"])
    ws.append([])
    ws.append(["Test ID", "Test Name", "Metric", "Pass Condition", "Threshold"])
    style_headers(ws, 4, 5)
    ws.append(["T1", "SLAM Loop Closure",    "LCE & Δθ",  "LCE < 0.15m AND Δθ < 5deg", ">4/5 trials"])
    ws.append(["T2", "Nav — No Obstacles",   "WRR",       "Within 0.1m",               ">8/10"])
    ws.append(["T3", "Nav — Static Obs",     "WRR",       "Within 0.1m",               ">6/10"])
    ws.append(["T4", "Nav — Dynamic Obs",    "WRR",       "Within 0.1m",               ">6/10"])

    if t1_results:
        ws_t1 = wb.create_sheet("T1 - SLAM Loop Closure")
        hdrs = ["Trial #", "Map Used", "Date",
                "Start X (m)", "Start Y (m)", "Start Yaw (deg)",
                "End X (m)", "End Y (m)", "End Yaw (deg)",
                "LCE (m)", "Δθ (deg)", "LCE < 0.15m?", "Δθ < 5deg?", "PASS/FAIL", "Notes"]
        ws_t1.append(hdrs)
        style_headers(ws_t1, 1, len(hdrs))
        for r in t1_results:
            ws_t1.append([
                r["trial_num"], r["map_used"], r["date"],
                round(r["start_x"], 4), round(r["start_y"], 4), round(r["start_yaw_deg"], 1),
                round(r["end_x"], 4), round(r["end_y"], 4), round(r["end_yaw_deg"], 1),
                round(r["lce"], 4), round(r["delta_theta_deg"], 1),
                r["lce_pass"], r["theta_pass"], r["result"], r["notes"],
            ])
        end = len(t1_results) + 1
        color_pass_fail(ws_t1, 12, 2, end)
        color_pass_fail(ws_t1, 13, 2, end)
        color_pass_fail(ws_t1, 14, 2, end)
        total  = len(t1_results)
        passed = sum(1 for r in t1_results if r["result"] == "PASS")
        ws_t1.append([])
        ws_t1.append(["SUMMARY"])
        ws_t1.append(["Total Trials", total])
        ws_t1.append(["Passed", passed])
        ws_t1.append(["Criteria Met? (>4/5)", "YES" if passed > 3 else "NO"])

    test_configs = {
        "T2": ("T2 - Nav No Obstacles",  "T2: Navigation — No Obstacles (WRR > 8/10)",  t2_results, 8),
        "T3": ("T3 - Nav Static Obs",    "T3: Navigation — Static Obstacles (WRR > 6/10)", t3_results, 6),
        "T4": ("T4 - Nav Dynamic Obs",   "T4: Navigation — Dynamic Obstacles (WRR > 6/10)", t4_results, 6),
    }
    for _, (sheet_name, title, results, thr) in test_configs.items():
        ws_t = wb.create_sheet(sheet_name)
        ws_t.append([title])
        ws_t["A1"].font = title_font
        hdrs = ["Trial #", "Map Used", "Date", "WP #",
                "Target X (m)", "Target Y (m)", "Target Yaw (deg)",
                "Actual X (m)", "Actual Y (m)", "Actual Yaw (deg)",
                "Dist Error (m)", "Heading Error (deg)",
                "Nav Completed?", "Within 0.1m?", "Result", "Notes"]
        ws_t.append(hdrs)
        style_headers(ws_t, 2, len(hdrs))
        if results:
            for r in results:
                ws_t.append([
                    r["trial_num"], r["map_used"], r["date"], r["waypoint_num"],
                    round(r["target_x"], 4), round(r["target_y"], 4), round(r["target_yaw_deg"], 1),
                    round(r["actual_x"], 4), round(r["actual_y"], 4), round(r["actual_yaw_deg"], 1),
                    round(r["distance_error"], 4), round(r["heading_error_deg"], 1),
                    r["nav_completed"], r["within_threshold"], r["result"], r["notes"],
                ])
            end = len(results) + 2
            color_pass_fail(ws_t, 14, 3, end)
            color_pass_fail(ws_t, 15, 3, end)
            total  = len(results)
            passed = sum(1 for r in results if r["result"] == "PASS")
            errs   = [r["distance_error"] for r in results]
            ws_t.append([])
            ws_t.append(["SUMMARY"])
            ws_t.append(["Total Waypoints", total])
            ws_t.append(["Passed", passed])
            ws_t.append(["WRR", f"{passed/total:.0%}" if total else "0%"])
            ws_t.append([f"Criteria Met? (>{thr}/10)", "YES" if passed >= thr else "NO"])
            ws_t.append(["Mean Dist Error (m)", round(sum(errs) / len(errs), 4) if errs else 0])
            ws_t.append(["Max Dist Error (m)",  round(max(errs), 4) if errs else 0])

    ws_sum = wb.create_sheet("Results Summary")
    ws_sum.append(["BENCHMARK RESULTS"])
    ws_sum["A1"].font = title_font
    ws_sum.append([])
    ws_sum.append(["Test ID", "Test Name", "Criteria", "Result", "Pass?", "Notes"])
    style_headers(ws_sum, 3, 6)
    summary = []
    if t1_results:
        total  = len(t1_results)
        passed = sum(1 for r in t1_results if r["result"] == "PASS")
        summary.append(("T1", "SLAM Loop Closure", "LCE < 0.15m & Δθ < 5deg, >4/5",
                         f"{passed}/{total}", "YES" if passed > 3 else "NO", ""))
    for tid, (_, _, results, thr) in test_configs.items():
        names = {"T2": "Nav — No Obstacles", "T3": "Nav — Static Obstacles", "T4": "Nav — Dynamic Obstacles"}
        if results:
            total  = len(results)
            passed = sum(1 for r in results if r["result"] == "PASS")
            result_str = f"{passed}/{total}"
            is_pass = "YES" if passed >= thr else "NO"
        else:
            result_str, is_pass = "", ""
        summary.append((tid, names[tid], f"WRR > {thr}/10, within 0.1m", result_str, is_pass, ""))
    for row in summary:
        ws_sum.append(list(row))
    color_pass_fail(ws_sum, 5, 4, 3 + len(summary))
    tests_passed = sum(1 for r in summary if r[4] == "YES")
    ws_sum.append([])
    ws_sum.append(["OVERALL VERDICT"])
    ws_sum.append(["Tests Passed", tests_passed])
    ws_sum.append(["Total Tests", len(summary)])
    ws_sum.append(["Stack Ready?", "YES" if tests_passed == len(summary) else "NO"])

    xlsx_path = os.path.join(output_dir, "SLAM_Nav_Benchmark.xlsx")
    wb.save(xlsx_path)
    print(f"[benchmark] Excel: {xlsx_path}")
    return xlsx_path


def build_parser():
    parser = argparse.ArgumentParser(prog="benchmark.py",
                                     description="T1–T4 nav benchmark for nav_cmd_bridge")
    parser.add_argument("test_type", choices=["T1", "T2", "T3", "T4"])
    parser.add_argument("--map",        required=True, help="Map name")
    parser.add_argument("--waypoints",  default=None,  help="Waypoints CSV file (x,y[,yaw_rad])")
    parser.add_argument("--bridge",     action="store_true",
                        help="Collect waypoints from /goal_pose (RViz2) instead of file")
    parser.add_argument("--trials",     type=int, default=None)
    parser.add_argument("--ip",         default="10.21.31.103", help="Robot IP")
    parser.add_argument("--output-dir", default=None)
    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()

    test_type  = args.test_type
    map_name   = args.map
    robot_ip   = args.ip
    use_bridge = args.bridge
    trials     = args.trials if args.trials else (5 if test_type == "T1" else 1)
    out_dir    = args.output_dir or str(DEFAULT_OUTPUT_DIR / timestamp_dir())
    os.makedirs(out_dir, exist_ok=True)

    if test_type != "T1" and not use_bridge and not args.waypoints:
        print("[benchmark] ERROR: provide --waypoints <file> or --bridge for T2/T3/T4")
        sys.exit(1)
    if use_bridge and test_type == "T1":
        print("[benchmark] ERROR: --bridge not supported for T1")
        sys.exit(1)

    print(f"\n{'='*60}\n  BENCHMARK: {test_type}  |  Map: {map_name}\n{'='*60}")
    print(f"[benchmark] Output: {out_dir}\n")

    if not rclpy.ok():
        rclpy.init()

    t1_res = t2_res = t3_res = t4_res = None

    if test_type == "T1":
        t1_res = run_slam_test(map_name, trials, out_dir)
        write_t1_csv(t1_res, out_dir)
    else:
        if use_bridge:
            waypoints = collect_bridge_waypoints()
            if not waypoints:
                print("[benchmark] No waypoints collected — aborting")
                sys.exit(1)
        else:
            waypoints = read_waypoints_file(args.waypoints)
            if not waypoints:
                print(f"[benchmark] No waypoints in {args.waypoints}")
                sys.exit(1)

        print(f"[benchmark] {len(waypoints)} waypoints  |  threshold {SETTLE_THRESHOLD}m  |  {trials} trial(s)")
        results = run_waypoint_test(test_type, map_name, waypoints, trials, out_dir, robot_ip)
        write_waypoint_csv(test_type, results, out_dir)
        if test_type == "T2": t2_res = results
        elif test_type == "T3": t3_res = results
        elif test_type == "T4": t4_res = results

    generate_excel(out_dir, t1_results=t1_res, t2_results=t2_res,
                   t3_results=t3_res, t4_results=t4_res, map_name=map_name)
    print(f"\n[benchmark] Done. Results in: {out_dir}")


if __name__ == "__main__":
    main()
