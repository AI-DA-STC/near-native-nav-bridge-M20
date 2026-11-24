#!/usr/bin/env python3
"""A SLAM map as an image, for the Command center: map_grid.py <topic> <out.png> [<wait s>]

Reads one nav_msgs/OccupancyGrid from <topic> (latched: a dog's /GRID_MAP_relayed_<id>, or the ALOHA's /map through
aloha/bridge.sh), keeps only its known part (with a 1 m margin: a 200 m grid with a 30 m site in it becomes a 32 m
image), writes that as a PNG (occupied light, free a faint tint, unknown transparent; north up) and prints one JSON line
with where it lies in the map frame: {"x": its left edge, "y": its bottom edge, "w": metres wide, "h": metres high,
"yaw": the origin's yaw in degrees}. Waits <wait s> (default 15) for the map; without one, or with nothing known in it,
it says why on stderr and exits 1. Only rclpy and the standard library: one byte per cell, mapped through a palette, so
even a 4000 x 4000 grid takes about a second."""

import json
import math
import struct
import sys
import time
import zlib

import rclpy
from nav_msgs.msg import OccupancyGrid
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy

MARGIN_M = 1.0
UNKNOWN = 0xFF  # -1 as an unsigned byte

# The palette: 0 unknown (transparent), 1 free, 2 occupied, 3.. the values in between, ever more opaque
PALETTE = [(0, 0, 0, 0), (255, 255, 255, 16), (205, 212, 224, 235)] + [(205, 212, 224, 60 + int(v * 1.5)) for v in range(26, 65)]


def index_of(value):
    """A cell's palette entry: values are -1 (unknown) or 0..100 (occupied, in %)"""
    if value < 0:
        return 0
    if value >= 65:
        return 2
    if value <= 25:
        return 1
    return 3 + value - 26


# Each cell's byte (its int8 value, read unsigned) to its palette entry, for bytes.translate
TABLE = bytes(index_of(u if u < 128 else u - 256) for u in range(256))


def png(width, height, rows):
    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    plte = b"".join(bytes(c[:3]) for c in PALETTE)
    trns = bytes(c[3] for c in PALETTE)
    raw = b"".join(b"\x00" + row for row in rows)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 3, 0, 0, 0))
            + chunk(b"PLTE", plte) + chunk(b"tRNS", trns) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def known_bounds(cells, w, h):
    """The rows and columns with a known cell: (row0, row1, col0, col1), inclusive; None when all are unknown"""
    unknown_row = bytes([UNKNOWN]) * w
    rows = [r for r in range(h) if cells[r * w:(r + 1) * w] != unknown_row]
    if not rows:
        return None
    col0, col1 = w, -1
    for r in rows:
        row = cells[r * w:(r + 1) * w]
        col0 = min(col0, w - len(row.lstrip(b"\xff")))
        col1 = max(col1, len(row.rstrip(b"\xff")) - 1)
    return rows[0], rows[-1], col0, col1


def fail(why):
    print(f"map_grid.py: {why}", file=sys.stderr, flush=True)
    sys.exit(1)


def main():
    if len(sys.argv) not in (3, 4):
        sys.exit(__doc__)
    topic, out = sys.argv[1], sys.argv[2]
    wait = float(sys.argv[3]) if len(sys.argv) == 4 else 15.0
    rclpy.init()
    node = rclpy.create_node("command_center_map_grid")
    got = []
    qos = QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL, reliability=ReliabilityPolicy.RELIABLE)
    node.create_subscription(OccupancyGrid, topic, got.append, qos)
    end = time.monotonic() + wait
    while not got and time.monotonic() < end:
        rclpy.spin_once(node, timeout_sec=0.2)
    publishers = node.count_publishers(topic)
    rclpy.shutdown()
    if not got:
        fail(f"no map on {topic} within {wait:g} s ({publishers} publisher(s) of it)")
    grid = got[-1]
    w, h, res = grid.info.width, grid.info.height, grid.info.resolution
    try:
        cells = bytes(grid.data)  # an array of int8: its raw bytes, -1 as 0xFF
    except (TypeError, ValueError):
        cells = bytes(v & 0xFF for v in grid.data)  # a list of ints
    if len(cells) != w * h:
        fail(f"the map on {topic} says {w} x {h} cells but has {len(cells)}")
    bounds = known_bounds(cells, w, h)
    if bounds is None:
        fail(f"the map on {topic} ({w} x {h} cells) has no known cell yet")
    margin = int(round(MARGIN_M / res))
    r0, r1 = max(0, bounds[0] - margin), min(h - 1, bounds[1] + margin)
    c0, c1 = max(0, bounds[2] - margin), min(w - 1, bounds[3] + margin)
    # The grid's row 0 is at the origin, the bottom: the image's row 0 is its top
    rows = [cells[r * w + c0:r * w + c1 + 1].translate(TABLE) for r in range(r1, r0 - 1, -1)]
    with open(out, "wb") as f:
        f.write(png(c1 - c0 + 1, r1 - r0 + 1, rows))
    o = grid.info.origin
    yaw = math.atan2(2 * (o.orientation.w * o.orientation.z), 1 - 2 * o.orientation.z ** 2)
    # The crop's corner, in the map frame: along the origin's own axes (it is drawn unrotated, as before)
    dx, dy = c0 * res, r0 * res
    x = o.position.x + math.cos(yaw) * dx - math.sin(yaw) * dy
    y = o.position.y + math.sin(yaw) * dx + math.cos(yaw) * dy
    print(json.dumps({"x": x, "y": y, "w": (c1 - c0 + 1) * res, "h": (r1 - r0 + 1) * res, "yaw": math.degrees(yaw),
                      "cells": [c1 - c0 + 1, r1 - r0 + 1], "of": [w, h]}), flush=True)


if __name__ == "__main__":
    main()
