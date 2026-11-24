#!/usr/bin/env python3
"""Reports the suspicious box once a robot (R3, 738) has reached it and stopped, with that robot's photo of it:
demo/find_box.py [--robot 738] [--reach 2.0]

The box is where demo/box.json has it (map frame), shared with fleet_management.py and the Command Center; a UWB tag
on the box will replace that file later (box_pose). run_demo.sh (DETECT=fixed) starts it for R3 when the sweep
starts. The robot has reached the box once it is within --reach metres of it and has moved less than 5 cm in the last
second. Its photo is the first frame from its front camera (/camera_front_relayed_<robot>, scripts/camera_relay.py on
the robot) that arrives after it stopped; without one within 10 s the report has none. It prints, as
demo/detect_box.py does, then exits:
  [DETECT] Box found by robot 738 at x=1.45 y=6.51 (map), 1.6 m away, confidence 1.00, image <jpg | none>
Run with the fleet's ROS_DOMAIN_ID and fastdds_profile.xml, as run_demo.sh does."""

import argparse
import json
import math
import signal
import threading
import time
from collections import deque
from pathlib import Path

HERE = Path(__file__).resolve().parent
STILL_S = 1.0       # the robot has stopped once it moved less than STILL_M in this long
STILL_M = 0.05
PHOTO_WAIT_S = 10.0  # how long to wait for a frame after the stop


def say(text):
    print(f"[DETECT] {text}", flush=True)


def box_pose(path):
    """The box's centre on the map: demo/box.json, for now"""
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
    """The robot's poses on the map (relayed odometry) and its camera's latest frame"""

    def __init__(self, robot):
        import rclpy
        from nav_msgs.msg import Odometry
        from sensor_msgs.msg import CompressedImage
        sigint = signal.getsignal(signal.SIGINT)
        rclpy.init()
        if sigint is signal.SIG_IGN:  # a background job of run_demo.sh: Ctrl+C is for the foreground
            signal.signal(signal.SIGINT, signal.SIG_IGN)
        self.node = rclpy.create_node(f"box_finder_{robot}")
        self.lock = threading.Lock()
        self.poses = deque(maxlen=100)  # (monotonic, x, y)
        self.frame = None  # (monotonic, jpeg bytes)
        self.node.create_subscription(Odometry, f"/ODOM_relayed_{robot}", self._odom, 10)
        self.node.create_subscription(CompressedImage, f"/camera_front_relayed_{robot}", self._image, 1)
        threading.Thread(target=rclpy.spin, args=(self.node,), daemon=True).start()

    def _odom(self, msg):
        p = msg.pose.pose.position
        with self.lock:
            self.poses.append((time.monotonic(), p.x, p.y))

    def _image(self, msg):
        with self.lock:
            self.frame = (time.monotonic(), bytes(msg.data))

    def snapshot(self):
        with self.lock:
            return list(self.poses), self.frame


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--robot", default="738", help="the robot that finds the box (default 738, R3)")
    parser.add_argument("--reach", type=float, default=2.0, help="metres from the box that count as there (default 2)")
    parser.add_argument("--box", default=str(HERE / "box.json"), help="the box's place (default demo/box.json)")
    parser.add_argument("--out", default=str(HERE / "detections"), help="where the photo goes")
    args = parser.parse_args()

    box = box_pose(args.box)
    robot = Robot(args.robot)
    say(f"Waiting for robot {args.robot} to stop within {args.reach:.1f} m of the box at x={box[0]:.2f} y={box[1]:.2f}")
    try:
        while True:
            time.sleep(0.2)
            poses, _ = robot.snapshot()
            now = time.monotonic()
            if stopped_near(poses, box, args.reach, now):
                break
        _, x, y = poses[-1]
        image = "none"
        while time.monotonic() - now < PHOTO_WAIT_S:
            _, frame = robot.snapshot()
            if frame and frame[0] > now - STILL_S:  # taken once the robot had stopped
                path = Path(args.out) / time.strftime(f"box_%Y%m%d_%H%M%S_{args.robot}.jpg")
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(frame[1])
                image = str(path)
                break
            time.sleep(0.1)
        say(f"Box found by robot {args.robot} at x={box[0]:.2f} y={box[1]:.2f} (map), "
            f"{math.hypot(x - box[0], y - box[1]):.1f} m away, confidence 1.00, image {image}")
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
