#!/usr/bin/env python3
"""Teach and replay poses of the Aloha's two Piper arms through aloha/bridge.sh: manipulator.py teach|run [file.json].
teach saves both puppet arms' joint positions (/puppet/joint_left, /puppet/joint_right) at every ENTER. run drives the
puppet arms through the saved poses with /master/joint_left and /master/joint_right, which start_ms_piper.launch only
follows with mode:=1 auto_enable:=true. Every move starts and stops gently, from the previous pose (from where the arms
are, for the first) at --speed at most.

At the last pose but one (--photo-pose), before the arms go home, both wrist cameras photograph the box: the first frame
each takes once the arms are there (their stamps and the arms' are both the ALOHA's clock, so the Wi-Fi's delay does not
matter). The arms hold the pose until both photos are in, for at most 10 s, then 2 s longer. inspect_box.py then looks
for the tools in them while the arms go home. Ctrl+C stops sending: the arms stay where they are. Run with the bridge's
ROS_DOMAIN_ID."""

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import threading
import time

import rclpy
from sensor_msgs.msg import CompressedImage, JointState

ARMS = ("left", "right")
RATE = 50  # Hz: commands to each arm while running
GRIPPER = 6  # position index of the gripper opening, in m; joint0-5 are in rad
GRIPPER_SPEED = 0.1  # m/s at most
TOLERANCE = 0.05  # rad: how close joint0-5 get to a pose before the pause there
SETTLE_S = 5.0  # longest wait for that
# The wrist cameras, throttled JPEGs through aloha/bridge.sh (robot/stream.launch on the robot)
CAMERAS = {"left": "/camera_l/color/image_throttled/compressed", "right": "/camera_r/color/image_throttled/compressed"}
PHOTO_SETTLE_S = 0.3  # a photo is taken at least this long after the arms reached the pose: they have stopped shaking
PHOTO_TIMEOUT_S = 10.0  # longest the arms wait at the pose for the photos
PHOTO_HOLD_S = 2.0  # then they hold it this much longer, on top of --pause
PHOTO_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "demo", "detections"))
INSPECT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "inspect_box.py")
INSPECT_TIMEOUT_S = 60.0  # for its result, after the last pose
FRESH_S = 0.5  # older puppet positions are not saved
DEFAULT_FILE = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "demo", "waypoints",
                                             "current", "manipulator.json"))


def spin(node):
    try:
        rclpy.spin(node)
    except BaseException:  # Ctrl+C or shutdown: the main thread ends the script
        pass


def wait_for(latest, topics, timeout=10.0):
    end = time.monotonic() + timeout
    while missing := [t for t in topics if t not in latest]:
        if time.monotonic() > end:
            sys.exit(f"No {' or '.join(missing)}: start aloha/bridge.sh, and start_ms_piper.launch on the robot")
        time.sleep(0.1)


def say(text):
    """A line run_demo.sh's readers (the Command center, demo_gui.py) follow"""
    print(f"[INSPECT] {text}", flush=True)


def stamp_of(msg):
    """The message's stamp in s, on the clock of the machine that published it; 0 when unset"""
    return msg.header.stamp.sec + msg.header.stamp.nanosec * 1e-9


def photo_ready(frame, since_stamp, since_arrival):
    """Whether this camera frame (msg, arrival) was taken once the arms had stopped. The camera's stamp and the arms'
    (since_stamp) are both the ALOHA's clock; without stamps, by when it arrived here"""
    msg, arrived = frame
    if stamp_of(msg) > 0 and since_stamp > 0:
        return stamp_of(msg) >= since_stamp + PHOTO_SETTLE_S
    return arrived >= since_arrival + PHOTO_SETTLE_S + 1.0  # the Wi-Fi's delay, at worst about a second


def save(path, poses):
    rows = ",\n".join("    " + json.dumps(pose) for pose in poses)
    with open(path + ".tmp", "w") as f:
        f.write('{\n  "poses": [\n' + rows + "\n  ]\n}\n")
    os.replace(path + ".tmp", path)


def teach(latest, path):
    puppets = [f"/puppet/joint_{arm}" for arm in ARMS]
    wait_for(latest, puppets)
    poses, backed_up = [], False
    print(f"Move the arms to a pose and press ENTER to save it to {path}. u + ENTER drops the last pose, "
          "q + ENTER finishes")
    while True:
        try:
            line = input(f"Pose {len(poses) + 1}: ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if line == "q":
            break
        if line == "u":
            if not poses:
                continue
            poses.pop()
            print(f"  Dropped pose {len(poses) + 1}")
        elif line:
            print("  ENTER saves the pose, u + ENTER drops the last one, q + ENTER finishes")
            continue
        else:
            stale = [t for t in puppets if time.monotonic() - latest[t][1] > FRESH_S]
            if stale:
                print(f"  Not saved: nothing on {' or '.join(stale)} for {FRESH_S} s")
                continue
            poses.append({arm: [round(p, 5) for p in latest[f"/puppet/joint_{arm}"][0].position] for arm in ARMS})
            print("  " + "  ".join(f"{arm} [{', '.join(f'{p:.3f}' for p in poses[-1][arm])}]" for arm in ARMS))
        if not backed_up and os.path.exists(path):
            shutil.copyfile(path, path + ".bak")
            print(f"  The previous poses are in {path}.bak")
        backed_up = True
        save(path, poses)
    print(f"{len(poses)} poses in {path}")


def run(node, latest, path, speed, pause, photo_pose):
    with open(path) as f:
        poses = [{arm: [float(p) for p in pose[arm]] for arm in ARMS} for pose in json.load(f)["poses"]]
    if not poses:
        sys.exit(f"No poses in {path}")
    photo_at = photo_pose or max(1, len(poses) - 1)  # the last but one: before the arms go home
    if not 1 <= photo_at <= len(poses):
        sys.exit(f"--photo-pose {photo_pose}: {path} has poses 1 to {len(poses)}")
    wait_for(latest, [f"/puppet/joint_{arm}" for arm in ARMS])
    time.sleep(1.0)  # long enough to hear the master arms, if they publish
    busy = [f"/master/joint_{arm}" for arm in ARMS if f"/master/joint_{arm}" in latest]
    if busy:
        sys.exit(f"{' and '.join(busy)} already have a publisher: the master arms (start_ms_piper.launch mode:=0) "
                 "or another run_manipulator. Restart start_ms_piper.launch with mode:=1 auto_enable:=true")
    current = {arm: list(latest[f"/puppet/joint_{arm}"][0].position) for arm in ARMS}
    for i, pose in enumerate(poses, 1):
        if any(len(pose[arm]) != len(current[arm]) for arm in ARMS):
            sys.exit(f"Pose {i} in {path} does not have the {len(current['left'])} positions of /puppet/joint_*")
    pubs = {arm: node.create_publisher(JointState, f"/master/joint_{arm}", 10) for arm in ARMS}
    time.sleep(0.5)  # for the bridge to subscribe

    def send(pose):
        stamp = node.get_clock().now().to_msg()
        for arm in ARMS:
            n = len(pose[arm])
            msg = JointState(name=[f"joint{j}" for j in range(n)], position=pose[arm], velocity=[0.0] * n,
                             effort=[0.0] * n)
            msg.header.stamp = stamp
            pubs[arm].publish(msg)

    def off(pose):  # the furthest joint0-5 is from the pose, in rad
        return max(abs(p - g) for arm in ARMS
                   for p, g in list(zip(latest[f"/puppet/joint_{arm}"][0].position, pose[arm]))[:GRIPPER])

    def take_photos(pose):
        """Both wrist cameras' first frames once the arms are at the pose, held meanwhile: the saved JPEGs"""
        say("Taking photos with both wrist cameras")
        since_stamp = min(stamp_of(latest[f"/puppet/joint_{arm}"][0]) for arm in ARMS)
        since_arrival = time.monotonic()
        photos = {}
        while len(photos) < len(CAMERAS) and time.monotonic() < since_arrival + PHOTO_TIMEOUT_S:
            for side, topic in CAMERAS.items():
                if side not in photos and topic in latest and photo_ready(latest[topic], since_stamp, since_arrival):
                    photos[side] = latest[topic][0]
            send(pose)
            time.sleep(1 / RATE)
        os.makedirs(PHOTO_DIR, exist_ok=True)
        stem = time.strftime("contents_%Y%m%d_%H%M%S")
        saved = []
        for side, topic in CAMERAS.items():
            if side not in photos:
                say(f"No photo: nothing from the {side} wrist camera ({topic}) in {PHOTO_TIMEOUT_S:.0f} s. "
                    "Is robot/stream.launch running on the ALOHA?")
                continue
            saved.append(os.path.join(PHOTO_DIR, f"{stem}_{side}.jpg"))
            with open(saved[-1], "wb") as f:
                f.write(bytes(photos[side].data))
        print(f"  Photos in {time.monotonic() - since_arrival:.1f} s: {', '.join(saved) or 'none'}")
        return saved

    inspect = None
    for i, pose in enumerate(poses, 1):
        print(f"Pose {i}/{len(poses)}")
        duration = 1.5 * max(abs(g - s) / (GRIPPER_SPEED if j == GRIPPER else speed)
                             for arm in ARMS for j, (s, g) in enumerate(zip(current[arm], pose[arm])))
        steps = max(1, math.ceil(duration * RATE))
        start = time.monotonic()
        for k in range(1, steps + 1):
            s = k / steps
            s = s * s * (3 - 2 * s)  # smoothstep: eases in and out, peaking at 1.5x the average speed
            send({arm: [a + (b - a) * s for a, b in zip(current[arm], pose[arm])] for arm in ARMS})
            time.sleep(max(0.0, start + k / RATE - time.monotonic()))
        end = time.monotonic() + SETTLE_S
        while off(pose) > TOLERANCE and time.monotonic() < end:
            send(pose)
            time.sleep(1 / RATE)
        if off(pose) > TOLERANCE:
            print(f"  Still {off(pose):.2f} rad off after {SETTLE_S:.0f} s: is start_ms_piper.launch running with "
                  "mode:=1 auto_enable:=true?")
        if i == photo_at:
            photos = take_photos(pose)
            if photos:  # the tools in them, found while the arms go on
                inspect = subprocess.Popen([sys.executable, INSPECT, *photos])
        end = time.monotonic() + pause + (PHOTO_HOLD_S if i == photo_at else 0.0)
        while time.monotonic() < end:
            send(pose)
            time.sleep(1 / RATE)
        current = pose
    if inspect is not None:
        try:
            inspect.wait(INSPECT_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            inspect.kill()
            print(f"  inspect_box.py stopped: no result after {INSPECT_TIMEOUT_S:.0f} s")
    print(f"Done: the arms stay at pose {len(poses)}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("teach", "run"))
    parser.add_argument("file", nargs="?", default=DEFAULT_FILE, help="poses file (default: %(default)s)")
    parser.add_argument("--speed", type=float, default=0.5, help="run: fastest a joint moves, rad/s (default: %(default)s)")
    parser.add_argument("--pause", type=float, default=1.0, help="run: seconds at each pose (default: %(default)s)")
    parser.add_argument("--photo-pose", type=int, default=0,
                        help="run: the pose where the wrist cameras photograph the box (default: the last but one)")
    args = parser.parse_args()
    if args.speed <= 0:
        parser.error("--speed must be above 0")

    rclpy.init()
    node = rclpy.create_node("aloha_manipulator")
    latest = {}  # topic -> (latest message, when it arrived)
    topics = [f"/puppet/joint_{arm}" for arm in ARMS] + [f"/master/joint_{arm}" for arm in ARMS if args.mode == "run"]
    for topic in topics:
        node.create_subscription(JointState, topic,
                                 lambda msg, topic=topic: latest.update({topic: (msg, time.monotonic())}), 1)
    if args.mode == "run":  # listening from the start, so the photos are taken the moment the arms are there
        for topic in CAMERAS.values():
            node.create_subscription(CompressedImage, topic,
                                     lambda msg, topic=topic: latest.update({topic: (msg, time.monotonic())}), 1)
    threading.Thread(target=spin, args=(node,), daemon=True).start()
    try:
        if args.mode == "teach":
            teach(latest, args.file)
        else:
            run(node, latest, args.file, args.speed, args.pause, args.photo_pose)
    except KeyboardInterrupt:
        print("\nStopped: the arms stay where they are")
        sys.exit(130)
    finally:
        try:
            rclpy.shutdown()
        except Exception:
            pass


if __name__ == "__main__":
    main()
