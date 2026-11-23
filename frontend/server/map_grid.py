#!/usr/bin/env python3
"""The dogs' SLAM map as an image, for the Command center: map_grid.py <topic> <out.png>

Reads one nav_msgs/OccupancyGrid from <topic> (/GRID_MAP_relayed_<id>, latched by the relay), writes it as an RGBA PNG
(occupied light, free a faint tint, unknown transparent; north up) and prints one JSON line with where it lies in the
map frame: {"x": origin x, "y": origin y, "w": metres wide, "h": metres high, "yaw": origin yaw in degrees}. Exits 1
with nothing printed when no map arrives within 15 s. Needs only rclpy and the standard library."""

import json
import math
import struct
import sys
import time
import zlib

import rclpy
from nav_msgs.msg import OccupancyGrid
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy

OCCUPIED = bytes((205, 212, 224, 235))
FREE = bytes((255, 255, 255, 16))
UNKNOWN = bytes((0, 0, 0, 0))


def png(width, height, rows):
    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + row for row in rows)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def cell(value):
    if value < 0:
        return UNKNOWN
    if value >= 65:
        return OCCUPIED
    if value <= 25:
        return FREE
    return bytes((205, 212, 224, 60 + int(value * 1.5)))


def main():
    topic, out = sys.argv[1], sys.argv[2]
    rclpy.init()
    node = rclpy.create_node("command_center_map_grid")
    got = []
    qos = QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL, reliability=ReliabilityPolicy.RELIABLE)
    node.create_subscription(OccupancyGrid, topic, got.append, qos)
    end = time.monotonic() + 15
    while not got and time.monotonic() < end:
        rclpy.spin_once(node, timeout_sec=0.2)
    rclpy.shutdown()
    if not got:
        sys.exit(1)
    grid = got[-1]
    w, h, res = grid.info.width, grid.info.height, grid.info.resolution
    cells = [cell(v) for v in grid.data]
    # The grid's row 0 is at the origin, the bottom: the image's row 0 is its top
    rows = [b"".join(cells[r * w:(r + 1) * w]) for r in range(h - 1, -1, -1)]
    with open(out, "wb") as f:
        f.write(png(w, h, rows))
    o = grid.info.origin
    yaw = math.degrees(math.atan2(2 * (o.orientation.w * o.orientation.z), 1 - 2 * o.orientation.z ** 2))
    print(json.dumps({"x": o.position.x, "y": o.position.y, "w": w * res, "h": h * res, "yaw": yaw}), flush=True)


if __name__ == "__main__":
    main()
