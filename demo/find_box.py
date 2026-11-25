#!/usr/bin/env python3
"""Reports the suspicious box once a robot (R3, 738) has reached it and stopped:
demo/find_box.py [--robot 738] [--reach 2.0] [--image <photo> | --image none]

The box is where demo/assets/box.json has it (map frame), shared with fleet_management.py and the Command Center; a
UWB tag on the box will replace that file later (box_pose). run_demo.sh (DETECT=fixed) starts it for R3 when the sweep
starts. The robot has reached the box once it is within --reach metres of it and has moved less than 5 cm in the last
second. The dogs' cameras stay on the dogs (relayed, they flooded the shared Wi-Fi), so the report carries a photo of
the box taken beforehand, demo/assets/unattended_item.jpg (--image), which the Command Center and demo_gui.py show
with the finding. It prints the [DETECT] line they read, then exits:
  [DETECT] Box found by robot 738 at x=1.45 y=6.51 (map), 1.6 m away, confidence 1.00, image <the photo's path>
with "image none" for --image none, or when the photo is missing. Run with the fleet's ROS_DOMAIN_ID and
fastdds_profile.xml, as run_demo.sh does."""

import argparse
import json
import math
import signal
import threading
import time
from collections import deque
from pathlib import Path

HERE = Path(__file__).resolve().parent
ASSETS = HERE / "assets"
STILL_S = 1.0       # the robot has stopped once it moved less than STILL_M in this long
STILL_M = 0.05


def say(text):
    print(f"[DETECT] {text}", flush=True)


def box_pose(path):
    """The box's centre on the map: demo/assets/box.json, for now"""
    with open(path) as f:
        box = json.load(f)
    return float(box["x"]), float(box["y"])


def stopped_near(poses, box, reach, now):
    """Whether the robot is within `reach` of the box and still: poses are (time, x, y), oldest first"""
    if not poses or now - poses[-1][0] > 1.0:
        return False
    _, x, y = poses[-1]
    if math.hypot(x - box[0], y - box[1]) > reach:
        return False
    recent = [p for p in poses if now - p[0] <= STILL_S]
    if not recent or recent[0][0] > now - STILL_S + 0.2:  # less than a second of poses yet
        return False
    return max(math.hypot(px - x, py - y) for _, px, py in recent) < STILL_M


class Robot:
    """The robot's poses on the map (relayed odometry)"""

    def __init__(self, robot):
        import rclpy
        from nav_msgs.msg import Odometry
        sigint = signal.getsignal(signal.SIGINT)
        rclpy.init()
        if sigint is signal.SIG_IGN:  # a background job of run_demo.sh: Ctrl+C is for the foreground
            signal.signal(signal.SIGINT, signal.SIG_IGN)
        self.node = rclpy.create_node(f"box_finder_{robot}")
        self.lock = threading.Lock()
        self.poses = deque(maxlen=100)  # (monotonic, x, y)
        self.node.create_subscription(Odometry, f"/ODOM_relayed_{robot}", self._odom, 10)
        threading.Thread(target=rclpy.spin, args=(self.node,), daemon=True).start()

    def _odom(self, msg):
        p = msg.pose.pose.position
        with self.lock:
            self.poses.append((time.monotonic(), p.x, p.y))

    def snapshot(self):
        with self.lock:
            return list(self.poses)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--robot", default="738", help="the robot that finds the box (default 738, R3)")
    parser.add_argument("--reach", type=float, default=2.0, help="metres from the box that count as there (default 2)")
    parser.add_argument("--box", default=str(ASSETS / "box.json"), help="the box's place (default demo/assets/box.json)")
    parser.add_argument("--image", default=str(ASSETS / "unattended_item.jpg"),
                        help="the photo of the box the report carries, or none (default demo/assets/unattended_item.jpg)")
    args = parser.parse_args()

    box = box_pose(args.box)
    image = "none" if args.image == "none" else Path(args.image).resolve()
    if image != "none" and not image.is_file():
        say(f"No photo of the box at {image}: the report says image none")
        image = "none"
    robot = Robot(args.robot)
    say(f"Waiting for robot {args.robot} to stop within {args.reach:.1f} m of the box at x={box[0]:.2f} y={box[1]:.2f}")
    try:
        while True:
            time.sleep(0.2)
            poses = robot.snapshot()
            if stopped_near(poses, box, args.reach, time.monotonic()):
                break
        _, x, y = poses[-1]
        say(f"Box found by robot {args.robot} at x={box[0]:.2f} y={box[1]:.2f} (map), "
            f"{math.hypot(x - box[0], y - box[1]):.1f} m away, confidence 1.00, image {image}")
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
