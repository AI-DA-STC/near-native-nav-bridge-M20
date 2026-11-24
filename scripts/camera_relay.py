#!/usr/bin/env python3
"""camera_relay.py: the M20's front camera for the laptop, one small JPEG a second.

Runs on the robot, in the nav_cmd_bridge container on the motion host (launch/relays.launch.py starts it with the
other relays), next to the camera's RTSP server (`url`, rtsp://10.21.31.103:8554/video1 on every M20). ffmpeg cuts the
stream down here, so only about one 640-px JPEG a second (40–60 KB) crosses the WiFi, published as
sensor_msgs/CompressedImage on `topic` (/camera_front_relayed_<ROBOT_ID>).

The motion host's free CPU is its little cores (the big ones are kept for the controller), shared with the RTSP server
and the lidar. So ffmpeg runs at nice 10, and decodes as little as it can: `skip_frame` nokey (the default) decodes
only the keyframes. A watchdog restarts ffmpeg once no frame has come for `stall_s` (10 s), as a stream that stalls
without closing would hang it for good. If a session gave frames and then none, the camera sends too few keyframes:
it steps to nonintra (every intra frame), then to none (every frame, the most CPU), and says so. While the camera
sends nothing at all, it tries again every 5 s. It never exits on its own; Ctrl+C ends ffmpeg with it.

Parameters: url, topic, fps (1.0), width (640), quality (ffmpeg -q:v, 2 best .. 31 worst; 7), skip_frame (nokey,
nonintra or none), stall_s (10).
"""

import array
import subprocess
import threading
import time

import rclpy
from rclpy.node import Node
from sensor_msgs.msg import CompressedImage

SOI, EOI = b"\xff\xd8", b"\xff\xd9"
RETRY_S = 5.0
# What ffmpeg leaves undecoded, least work first; each step down when frames stop coming
SKIP_STEPS = ("nokey", "nonintra", "none")


def jpegs(buffer):
    """The whole JPEGs at the start of `buffer`, and what is left. Inside a JPEG's data every 0xFF byte is stuffed, so
    FF D9 only ever ends one."""
    frames = []
    while True:
        start = buffer.find(SOI)
        end = buffer.find(EOI, start + 2) if start >= 0 else -1
        if end < 0:
            return frames, buffer[start:] if start >= 0 else b""
        frames.append(buffer[start:end + 2])
        buffer = buffer[end + 2:]


class CameraRelay(Node):
    def __init__(self):
        super().__init__("camera_relay")
        self.url = self.declare_parameter("url", "rtsp://10.21.31.103:8554/video1").value
        topic = self.declare_parameter("topic", "/camera_front_relayed").value
        self.fps = float(self.declare_parameter("fps", 1.0).value)
        self.width = int(self.declare_parameter("width", 640).value)
        self.quality = int(self.declare_parameter("quality", 7).value)
        self.skip_frame = str(self.declare_parameter("skip_frame", "nokey").value)
        if self.skip_frame not in SKIP_STEPS:
            self.get_logger().warn(f"skip_frame {self.skip_frame!r} is not one of {', '.join(SKIP_STEPS)}: nokey")
            self.skip_frame = "nokey"
        self.stall_s = float(self.declare_parameter("stall_s", 10.0).value)
        self.pub = self.create_publisher(CompressedImage, topic, 1)
        self.get_logger().info(f"{self.url} → {topic}, at most {self.fps:g} frame(s) a second, {self.width} px wide")
        self.stopping = threading.Event()
        self.proc = None  # the ffmpeg running now
        self.worker = threading.Thread(target=self.run, daemon=True)
        self.worker.start()

    def stop(self):
        """Ends ffmpeg and the thread reading it, before the node goes: on Ctrl+C (ros2 launch's SIGINT) the process
        then exits at once, rather than hang with a thread still publishing"""
        self.stopping.set()
        proc = self.proc
        if proc is not None and proc.poll() is None:
            proc.kill()
        self.worker.join(timeout=3.0)

    def command(self):
        return [
            "nice", "-n", "10", "ffmpeg", "-nostdin", "-loglevel", "error", "-rtsp_transport", "tcp",
            *(["-skip_frame", self.skip_frame] if self.skip_frame != "none" else []),
            "-i", self.url, "-an",
            "-vf", f"fps={self.fps:g},scale={self.width}:-2",
            "-c:v", "mjpeg", "-q:v", str(self.quality), "-f", "image2pipe", "-",
        ]

    def run(self):
        live = None  # the last state logged: True (frames arrive) or False (none)
        while not self.stopping.is_set():
            try:
                proc = subprocess.Popen(self.command(), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                self.proc = proc
            except FileNotFoundError:
                self.get_logger().warn("ffmpeg is not installed in this container: rebuild the image (Dockerfile.deploy)")
                return
            session = {"last": time.monotonic(), "frames": 0, "stalled": False}
            threading.Thread(target=self.watchdog, args=(proc, session), daemon=True).start()
            buffer, last_sent = b"", 0.0
            while not self.stopping.is_set():
                chunk = proc.stdout.read1(65536)
                if not chunk:
                    break
                frames, buffer = jpegs(buffer + chunk)
                for frame in frames:
                    now = time.monotonic()
                    session["last"] = now
                    session["frames"] += 1
                    if now - last_sent < 0.9 / self.fps:
                        continue
                    last_sent = now
                    if live is not True:
                        live = True
                        self.get_logger().info(f"Video from {self.url}, skip_frame {self.skip_frame}")
                    msg = CompressedImage(format="jpeg", data=array.array("B", frame))
                    msg.header.stamp = self.get_clock().now().to_msg()
                    msg.header.frame_id = "front_camera"
                    self.pub.publish(msg)
            if self.stopping.is_set():
                proc.kill()
                proc.wait()
                return
            proc.wait()
            if session["stalled"] and session["frames"]:
                step = SKIP_STEPS.index(self.skip_frame)
                if step + 1 < len(SKIP_STEPS):
                    self.skip_frame = SKIP_STEPS[step + 1]
                    self.get_logger().warn(f"No frame for {self.stall_s:g} s from {self.url} after some: too few keyframes, "
                                           f"skip_frame {self.skip_frame} from now on (more CPU)")
                else:
                    self.get_logger().warn(f"No frame for {self.stall_s:g} s from {self.url}: restarting ffmpeg")
                live = None
                self.stopping.wait(1.0)
                continue
            if live is not False:
                live = False
                why = proc.stderr.read().decode(errors="replace").strip().splitlines()
                stalled = f"nothing for {self.stall_s:g} s" if session["stalled"] else None
                reason = why[-1] if why else stalled
                self.get_logger().warn(f"No video from {self.url}{': ' + reason if reason else ''}; trying again every {RETRY_S:g} s")
            self.stopping.wait(RETRY_S)

    def watchdog(self, proc, session):
        """Ends a session that has given no frame for stall_s: ffmpeg would wait for good on a stalled stream"""
        while proc.poll() is None:
            time.sleep(1.0)
            if time.monotonic() - session["last"] > self.stall_s:
                session["stalled"] = True
                proc.kill()
                return


def main():
    rclpy.init()
    node = CameraRelay()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.stop()
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
