#!/usr/bin/env python3
"""Looks for the suspicious box through one robot's front camera, with the YOLO26 box model of
external/lynx-M20-yolo, and says where it is on the map: demo/detect_box.py [--robot 738] [--source <stream or file>]

run_demo.sh starts it for R3 when the sweep starts; it runs until the demo ends. It opens only that robot's camera:
the stream in the submodule's live_config.yaml (robot 738's front camera). The box model runs at the config's
inference_fps. A box the tracker follows for CONFIRM frames is reported, with its place on the map from the robot's
pose on /ODOM_relayed_<robot> (map frame) and the box's distance and bearing in the image. The distance is the
config's box distance from the box height if enabled, else the depth model's:
  [DETECT] Box found by robot 738 at x=4.07 y=-0.50 (map), 2.3 m away, confidence 0.87, image <jpg>
A closer view of the same box later gives [DETECT] Box update ..., with the same fields. Without a distance or a pose
yet, the first report says "position not measured yet" and an update follows once it is. Run with the fleet's
ROS_DOMAIN_ID and fastdds_profile.xml, as run_demo.sh does."""

import argparse
import math
import signal
import sys
import threading
import time
from collections import deque
from pathlib import Path

HERE = Path(__file__).resolve().parent
YOLO_DIR = HERE.parent / "external" / "lynx-M20-yolo"
CONFIRM = 3          # frames the tracker follows a box before it is reported
MIN_CONF = 0.5       # confidence each of those frames needs
SAME_BOX_M = 1.5     # estimates closer than this to the reported box are that box
UPDATE_S = 2.0       # at most one update this often
CLOSER = 0.85        # an update needs a view at most this fraction of the reported distance
CAMERA_LAG_S = 0.15  # the stream's delay: the robot's pose this long before a frame arrived
WORK_WIDTH = 640     # the depth map is matched to the box mask at this width


def say(text):
    print(f"[DETECT] {text}", flush=True)


def wrap(a):
    return math.atan2(math.sin(a), math.cos(a))


class Poses:
    """The robot's latest poses on the map, from its relayed odometry"""

    def __init__(self, robot):
        import rclpy
        from nav_msgs.msg import Odometry
        sigint = signal.getsignal(signal.SIGINT)
        rclpy.init()
        if sigint is signal.SIG_IGN:  # a background job of run_demo.sh: Ctrl+C is for the foreground
            signal.signal(signal.SIGINT, signal.SIG_IGN)
        self.node = rclpy.create_node(f"box_detector_{robot}")
        self.lock = threading.Lock()
        self.poses = deque(maxlen=200)  # (perf_counter, x, y, yaw)
        self.node.create_subscription(Odometry, f"/ODOM_relayed_{robot}", self._odom, 10)
        threading.Thread(target=rclpy.spin, args=(self.node,), daemon=True).start()

    def _odom(self, msg):
        p, q = msg.pose.pose.position, msg.pose.pose.orientation
        yaw = math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z))
        with self.lock:
            self.poses.append((time.perf_counter(), p.x, p.y, yaw))

    def at(self, t):
        """The pose nearest to perf_counter time t, if one is within a second of it"""
        with self.lock:
            best = min(self.poses, key=lambda s: abs(s[0] - t), default=None)
        return best[1:] if best and abs(best[0] - t) < 1.0 else None


class Ranger:
    """Distance and bearing of a box in a frame, as live.py measures them"""

    def __init__(self, cfg, size, device):
        import numpy as np
        from helpers.box_distance import BoxDistance, scale_camera_matrix
        from helpers.orbbec_view import OrbbecView
        from ultralytics import YOLO
        self.np, self.cfg, self.device, self.size = np, cfg, device, size
        cam = cfg["camera"]
        self.K = scale_camera_matrix(cam["camera_matrix"], cam["calib_size"], size)
        self.D = np.array(cam["dist_coeffs"], np.float64)
        bd = cfg.get("box_distance") or {}
        self.heights = BoxDistance({**bd, **cam}, size) if bd.get("enabled") else None
        self.depth = YOLO(cfg["models"]["depth"]) if cfg["models"].get("depth") else None
        ov = cfg.get("orbbec_view") or {}
        self.orbbec = OrbbecView(cam, ov, size) if self.depth is not None and ov.get("enabled") else None

    def measure(self, frame, dets):
        """Adds 'range' (m along the camera axis, or None) and 'side' (x/z in the undistorted image) to each detection"""
        import cv2
        from live import object_mask, to_numpy
        np = self.np
        for d in dets:
            x1, y1, x2, y2 = d["box"]
            pt = np.array([[[(x1 + x2) / 2, (y1 + y2) / 2]]], np.float64)
            d["side"] = float(cv2.undistortPoints(pt, self.K, self.D)[0, 0, 0])
            d["range"] = None
        if self.heights is not None:
            self.heights.update(dets, frame.shape[0])
            for d in dets:
                d["range"] = (d.get("dist") or {}).get("height")
        if self.depth is not None and any(d["range"] is None for d in dets):
            w, h = self.size
            scale = WORK_WIDTH / w
            small = (WORK_WIDTH, int(round(h * scale)))
            src = self.orbbec.to_orbbec(frame) if self.orbbec else frame
            depth = to_numpy(self.depth.predict(src, device=self.device, verbose=False)[0].depth.data)
            depth = depth.squeeze().astype(np.float32)
            if self.orbbec:
                depth = cv2.resize(depth, self.orbbec.dst_size, interpolation=cv2.INTER_LINEAR)
                depth = self.orbbec.to_frame(depth, small, scale)
            else:
                depth = cv2.resize(depth, small, interpolation=cv2.INTER_AREA)
            for d in dets:
                if d["range"] is None:
                    vals = depth[object_mask(d, scale, small)]
                    vals = vals[vals > 0]
                    d["range"] = float(np.median(vals)) * self.cfg["depth_scale"] if vals.size else None


def snapshot(frame, det, path):
    """The box, outlined, with its surroundings, 4:3"""
    import cv2
    import numpy as np
    h, w = frame.shape[:2]
    img = frame.copy()
    x1, y1, x2, y2 = (int(v) for v in det["box"])
    if det["poly"] is not None and len(det["poly"]) >= 3:
        cv2.polylines(img, [det["poly"].astype(np.int32)], True, (0, 0, 0), 5, cv2.LINE_AA)
        cv2.polylines(img, [det["poly"].astype(np.int32)], True, (255, 255, 255), 2, cv2.LINE_AA)
    else:
        cv2.rectangle(img, (x1, y1), (x2, y2), (0, 0, 0), 5)
        cv2.rectangle(img, (x1, y1), (x2, y2), (255, 255, 255), 2)
    cw = min(w, max(320, 3 * (x2 - x1), 4 * 3 * (y2 - y1) // 3))
    ch = min(h, cw * 3 // 4)
    cw = min(cw, ch * 4 // 3)
    cx = min(max((x1 + x2) // 2 - cw // 2, 0), w - cw)
    cy = min(max((y1 + y2) // 2 - ch // 2, 0), h - ch)
    crop = cv2.resize(img[cy:cy + ch, cx:cx + cw], (480, 360), interpolation=cv2.INTER_AREA)
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(path), crop, [cv2.IMWRITE_JPEG_QUALITY, 90])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--robot", default="738", help="the robot whose camera is in the config (default 738)")
    parser.add_argument("--config", default=str(YOLO_DIR / "live_config.yaml"))
    parser.add_argument("--source", help="stream URL, video or image instead of the config's")
    parser.add_argument("--camera-offset", type=float, default=0.0,
                        help="metres from the robot's pose ahead to the camera lens (default 0)")
    parser.add_argument("--out", default=str(HERE / "detections"), help="where the box images go")
    parser.add_argument("--give-up", type=int, default=0, metavar="N",
                        help="exit (code 2) after N failed tries to open the stream, before any video (default: never)")
    args = parser.parse_args()

    say(f"Starting box detection on robot {args.robot}'s camera")
    sys.path.insert(0, str(YOLO_DIR))
    try:
        import torch
        from live import LatestFrameGrabber, extract_detections, load_config
        from ultralytics import YOLO
    except ImportError as e:
        say(f"Cannot start: {e}. Install it with pip3 install -r {HERE / 'requirements-detect.txt'}")
        sys.exit(1)
    cfg = load_config(Path(args.config).resolve())
    if args.source:
        cfg["source"] = args.source if "://" in args.source else str(Path(args.source).resolve())
    device = cfg["device"] if str(cfg["device"]) == "cpu" or torch.cuda.is_available() else "cpu"
    names = set((cfg.get("box_distance") or {}).get("box_class_names") or ["box"])
    seg = YOLO(cfg["models"]["segment"])
    poses = Poses(args.robot)
    class Grabber(LatestFrameGrabber):  # counts the failed tries to open the stream
        failures = 0

        def _open(self):
            cap = super()._open()
            if not cap.isOpened():
                self.failures += 1
            return cap

    grabber = Grabber(cfg["source"], cfg.get("rtsp_transport"), int(cfg["open_timeout_ms"]))
    period = 1.0 / float(cfg["inference_fps"])

    ranger = None
    seen = {}  # track id -> frames followed at MIN_CONF or more
    report = None  # what was last reported: x, y, range, time
    last_id, next_t, watching = 0, 0.0, False
    try:
        while True:
            frame_id, frame = grabber.latest()
            now = time.perf_counter()
            if args.give_up and frame is None and grabber.failures >= args.give_up:
                say(f"No video from robot {args.robot}'s camera after {grabber.failures} tries: giving up")
                sys.exit(2)
            if frame is None or frame_id == last_id or now < next_t:
                time.sleep(0.02)
                continue
            last_id, next_t, arrived = frame_id, now + period, grabber.last_frame_time
            if not watching:
                watching = True
                say(f"Watching robot {args.robot}'s camera for the box ({device})")
            if ranger is None:
                ranger = Ranger(cfg, (frame.shape[1], frame.shape[0]), device)
            res = seg.track(frame, persist=True, tracker=cfg["tracker"], conf=cfg["conf"], imgsz=cfg["imgsz"],
                            device=device, verbose=False)[0]
            dets = [d for d in extract_detections(res) if d["name"] in names and d["id"] is not None]
            for d in dets:
                if d["conf"] >= MIN_CONF:
                    seen[d["id"]] = seen.get(d["id"], 0) + 1
            confirmed = [d for d in dets if seen.get(d["id"], 0) >= CONFIRM and d["conf"] >= MIN_CONF]
            if not confirmed:
                continue
            ranger.measure(frame, confirmed)
            pose = poses.at(arrived - CAMERA_LAG_S)
            for d in confirmed:
                d["xy"] = None
                if d["range"] is not None and pose is not None:
                    rx, ry, yaw = pose
                    ahead, left = args.camera_offset + d["range"], -d["side"] * d["range"]
                    d["xy"] = (rx + math.cos(yaw) * ahead - math.sin(yaw) * left,
                               ry + math.sin(yaw) * ahead + math.cos(yaw) * left)
                    d["away"] = math.hypot(ahead, left)
            if report is not None:  # the same box, seen better
                confirmed = [d for d in confirmed if d["xy"] is not None
                             and (report["xy"] is None or math.dist(d["xy"], report["xy"]) < SAME_BOX_M)]
                confirmed = [d for d in confirmed if report["xy"] is None
                             or (d["away"] < CLOSER * report["away"] and now - report["t"] > UPDATE_S)]
            if not confirmed:
                continue
            best = min(confirmed, key=lambda d: (d["xy"] is None, d.get("away", 0), -d["conf"]))
            image = Path(args.out) / time.strftime(f"box_%Y%m%d_%H%M%S_{best['id']}.jpg")
            snapshot(frame, best, image)
            where = (f"at x={best['xy'][0]:.2f} y={best['xy'][1]:.2f} (map), {best['away']:.1f} m away"
                     if best["xy"] is not None else "position not measured yet")
            say(f"Box {'found' if report is None else 'update'} by robot {args.robot} {where}, "
                f"confidence {best['conf']:.2f}, image {image}")
            report = {"xy": best["xy"], "away": best.get("away"), "t": now}
    except KeyboardInterrupt:
        pass
    finally:
        grabber.stop()  # waits for a try to open the stream to end


if __name__ == "__main__":
    main()
