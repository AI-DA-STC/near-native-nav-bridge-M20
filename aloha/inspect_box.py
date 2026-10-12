#!/usr/bin/env python3
"""Takes one photo of what is in the box with the Aloha's right wrist camera and finds the tools in it with the YOLO26
tools model, external/lynx-M20-yolo/weights/tools_seg.pt: aloha/inspect_box.py [--topic ...] [--out ...]

manipulator.py runs it when the arms have reached pose 3, which they hold 5 s longer for it. The photo comes from
/camera_r/color/image_raw (aloha/bridge.sh, with robot/stream.launch on the robot) and is taken first; the model then
runs on that one image. Run with the bridge's ROS_DOMAIN_ID (1). Prints
  [INSPECT] Box contents: drill 0.91, pliers 0.84; image <jpg with the objects outlined>
or "Box contents: nothing found; image ...". Problems print [INSPECT] No photo: ... or [INSPECT] Cannot run: ..."""

import argparse
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODEL = HERE.parent / "external" / "lynx-M20-yolo" / "weights" / "tools_seg.pt"
CONF = 0.25          # lowest confidence of an object reported
SETTLE_S = 0.5       # a frame from at least this long after the start: the camera has stopped moving
PHOTO_TIMEOUT_S = 5.0


def say(text):
    print(f"[INSPECT] {text}", flush=True)


def photo(topic):
    """One frame from the topic, as a BGR image, or None"""
    import numpy as np
    import rclpy
    from sensor_msgs.msg import Image
    rclpy.init()
    node = rclpy.create_node("aloha_inspect_box")
    frames = []
    node.create_subscription(Image, topic, frames.append, 1)
    start = time.monotonic()
    try:
        while time.monotonic() - start < SETTLE_S + PHOTO_TIMEOUT_S:
            rclpy.spin_once(node, timeout_sec=0.1)
            if frames and time.monotonic() - start >= SETTLE_S:
                msg = frames[-1]
                break
            frames.clear()
        else:
            return None
    finally:
        rclpy.shutdown()
    if msg.encoding not in ("rgb8", "bgr8"):
        say(f"Cannot run: {topic} is {msg.encoding}, not rgb8 or bgr8")
        sys.exit(1)
    image = np.frombuffer(bytes(msg.data), np.uint8).reshape(msg.height, msg.step)[:, :msg.width * 3]
    image = image.reshape(msg.height, msg.width, 3)
    return image[:, :, ::-1].copy() if msg.encoding == "rgb8" else image.copy()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--topic", default="/camera_r/color/image_raw")
    parser.add_argument("--out", default=str(HERE.parent / "demo" / "detections"), help="where the photos go")
    args = parser.parse_args()

    say("Taking a photo of the box's contents")
    image = photo(args.topic)
    if image is None:
        say(f"No photo: nothing on {args.topic} for {PHOTO_TIMEOUT_S:.0f} s. Is aloha/bridge.sh running, "
            "and robot/stream.launch on the robot?")
        sys.exit(1)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    stem = time.strftime("contents_%Y%m%d_%H%M%S")
    try:
        import cv2
        import torch
        from ultralytics import YOLO
    except ImportError as e:
        say(f"Cannot run: {e}. Install it with pip3 install -r {HERE.parent / 'demo' / 'requirements-detect.txt'}")
        sys.exit(1)
    cv2.imwrite(str(out / f"{stem}_photo.jpg"), image, [cv2.IMWRITE_JPEG_QUALITY, 90])
    result = YOLO(str(MODEL)).predict(image, conf=CONF, device=0 if torch.cuda.is_available() else "cpu",
                                      verbose=False)[0]
    found = sorted(((result.names[int(c)], float(p)) for c, p in zip(result.boxes.cls, result.boxes.conf)),
                   key=lambda item: -item[1])
    path = out / f"{stem}.jpg"
    cv2.imwrite(str(path), result.plot(line_width=2), [cv2.IMWRITE_JPEG_QUALITY, 90])
    say(f"Box contents: {', '.join(f'{name} {p:.2f}' for name, p in found) or 'nothing found'}; image {path}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # said as a result, for the operator window
        say(f"Cannot run: {e}")
        sys.exit(1)
