#!/usr/bin/env python3
"""The Command Center's camera feeds: frontend/server/camera_frames.py <dir> <key>=<topic> [<key>=<topic> ...]

Subscribes to each sensor_msgs/CompressedImage topic and keeps at most one frame a second of each as <dir>/<key>.jpg,
replaced whole (written aside, then renamed), printing `frame <key> <epoch ms>` for each. Run it with the topics'
ROS_DOMAIN_ID: 0 for the dogs' /camera_front_relayed_<id> (scripts/camera_relay.py on each dog), 1 for the ALOHA's
cameras through aloha/bridge.sh. Ctrl+C (SIGINT) ends it."""

import os
import sys
import time

import rclpy
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import CompressedImage

EVERY_S = 0.95  # at most one frame a second, with room for the publisher's jitter


def main():
    if len(sys.argv) < 3 or any("=" not in a for a in sys.argv[2:]):
        sys.exit(__doc__)
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    rclpy.init()
    node = rclpy.create_node("command_center_cameras")
    last = {}

    def keeper(key):
        path = os.path.join(out, f"{key}.jpg")

        def keep(msg):
            now = time.time()
            if now - last.get(key, 0.0) < EVERY_S:
                return
            last[key] = now
            with open(f"{path}.tmp", "wb") as f:
                f.write(bytes(msg.data))
            os.replace(f"{path}.tmp", path)
            print(f"frame {key} {int(now * 1000)}", flush=True)

        return keep

    for key, topic in (a.split("=", 1) for a in sys.argv[2:]):
        # best effort takes both reliable and best-effort publishers
        node.create_subscription(CompressedImage, topic, keeper(key), qos_profile_sensor_data)
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
