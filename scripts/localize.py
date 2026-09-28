#!/usr/bin/env python3
"""Check and fix an M20's localization from the laptop — no ssh -X, no RViz.

Runs on the Foxy side (domain 0, laptop fastdds_profile.xml), against a robot whose
relays are up. It overlays the robot's live cloud (/ALIGNED_POINTS_relayed_<id>, map
frame) on its map (/GRID_MAP_relayed_<id>) and scores the fit at the current pose
estimate, then searches nearby poses for a better one.

    python3 scripts/localize.py 834                 # report fit + best correction
    python3 scripts/localize.py 834 --apply         # send the correction if it helps
    python3 scripts/localize.py 834 --pose x y yaw  # set a pose by hand (like RViz
                                                    # "2D Pose Estimate"), then re-score

Poses are sent on /initialpose_set_relayed_<id>, which the robot relays to its own
/initialpose. The robot must be awake (standing): its lidar and localizer are idle
while it sleeps. Score = mean closeness of cloud points to occupied map cells
(1 = on a wall, 0 = nowhere near); a well-localized robot usually scores well above
0.5 and gains little from the search.
"""

import argparse
import math
import sys
import time

import numpy as np
import rclpy
from geometry_msgs.msg import PoseWithCovarianceStamped
from nav_msgs.msg import OccupancyGrid, Odometry
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import PointCloud2
from std_msgs.msg import Float64MultiArray


def yaw_of(q):
    return math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z))


class Data:
    def __init__(self, node, rid):
        self.map = self.cloud = self.odom = self.match = None
        latched = QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL,
                             reliability=ReliabilityPolicy.RELIABLE)
        node.create_subscription(OccupancyGrid, f'/GRID_MAP_relayed_{rid}',
                                 lambda m: setattr(self, 'map', m), latched)
        node.create_subscription(PointCloud2, f'/ALIGNED_POINTS_relayed_{rid}',
                                 lambda m: setattr(self, 'cloud', m), 5)
        node.create_subscription(Odometry, f'/ODOM_relayed_{rid}',
                                 lambda m: setattr(self, 'odom', m), 5)
        node.create_subscription(Float64MultiArray, f'/LOCATION_STATUS/MATCHING_ERROR_relayed_{rid}',
                                 lambda m: setattr(self, 'match', list(m.data)), 5)


def wait_for(node, pred, timeout, what):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        rclpy.spin_once(node, timeout_sec=0.1)
        if pred():
            return True
    sys.exit(f'no {what} within {timeout:.0f}s')


def likelihood_field(grid):
    """Per-cell closeness to an occupied cell: 1, 0.6 (1 cell away), 0.3 (2 cells)."""
    i = grid.info
    occ = (np.asarray(grid.data, dtype=np.int16).reshape(i.height, i.width) >= 50)
    field = occ.astype(np.float32)
    grown = occ.copy()
    for weight in (0.6, 0.3):
        g = grown.copy()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
            g |= np.roll(np.roll(grown, dy, axis=0), dx, axis=1)
        field = np.maximum(field, np.where(g & ~grown, weight, 0))
        grown = g
    return field


def cloud_xyz(msg):
    off = {f.name: f.offset for f in msg.fields}
    raw = np.frombuffer(msg.data, dtype=np.uint8).reshape(-1, msg.point_step)
    cols = [raw[:, off[k]:off[k] + 4].copy().view('<f4').ravel() for k in ('x', 'y', 'z')]
    pts = np.stack(cols, axis=1)
    return pts[np.isfinite(pts).all(axis=1)]


def select_points(pts, robot, max_points=4000):
    """Keep structure (not floor/ceiling) within 15 m of the robot."""
    rx, ry, rz = robot
    d = np.hypot(pts[:, 0] - rx, pts[:, 1] - ry)
    keep = (d > 0.5) & (d < 15.0) & (pts[:, 2] > rz - 0.25) & (pts[:, 2] < rz + 1.5)
    pts = pts[keep][:, :2]
    if len(pts) > max_points:
        pts = pts[np.linspace(0, len(pts) - 1, max_points).astype(int)]
    return pts


def score(field, info, pts):
    ox, oy, r = info.origin.position.x, info.origin.position.y, info.resolution
    c = ((pts[:, 0] - ox) / r).astype(int)
    rr = ((pts[:, 1] - oy) / r).astype(int)
    ok = (c >= 0) & (c < info.width) & (rr >= 0) & (rr < info.height)
    s = np.zeros(len(pts), dtype=np.float32)
    s[ok] = field[rr[ok], c[ok]]
    return float(s.mean()) if len(pts) else 0.0


def search(field, info, pts, pivot, radius, yaw_range, step=0.1, yaw_step=math.radians(2)):
    """Best rigid correction (dx, dy, dyaw) of the cloud about the robot position."""
    best = (score(field, info, pts), 0.0, 0.0, 0.0)
    rel = pts - pivot
    offsets = np.arange(-radius, radius + 1e-9, step)
    for dth in np.arange(-yaw_range, yaw_range + 1e-9, yaw_step):
        c, s = math.cos(dth), math.sin(dth)
        rot = rel @ np.array([[c, s], [-s, c]]) + pivot
        for dx in offsets:
            for dy in offsets:
                v = score(field, info, rot + (dx, dy))
                if v > best[0] + 1e-6:
                    best = (v, dx, dy, dth)
    return best


def publish_pose(node, rid, x, y, yaw):
    pub = node.create_publisher(PoseWithCovarianceStamped, f'/initialpose_set_relayed_{rid}', 10)
    end = time.monotonic() + 5.0
    while pub.get_subscription_count() == 0 and time.monotonic() < end:
        rclpy.spin_once(node, timeout_sec=0.1)
    if pub.get_subscription_count() == 0:
        sys.exit(f'nothing subscribes to /initialpose_set_relayed_{rid}: is the '
                 'initialpose_set relay running on the robot?')
    m = PoseWithCovarianceStamped()
    m.header.frame_id = 'map'
    m.pose.pose.position.x, m.pose.pose.position.y = float(x), float(y)
    m.pose.pose.orientation.z, m.pose.pose.orientation.w = math.sin(yaw / 2), math.cos(yaw / 2)
    cov = [0.0] * 36
    cov[0] = cov[7] = 0.25
    cov[35] = 0.07
    m.pose.covariance = cov
    for _ in range(3):
        m.header.stamp = node.get_clock().now().to_msg()
        pub.publish(m)
        rclpy.spin_once(node, timeout_sec=0.3)
    print(f'sent initial pose ({x:.3f}, {y:.3f}, {yaw:.3f} rad)')


def assess(node, data, rid, radius, yaw_range):
    data.cloud = None
    wait_for(node, lambda: data.cloud is not None and data.odom is not None, 20,
             f'cloud on /ALIGNED_POINTS_relayed_{rid} (robot asleep? relay up?)')
    p = data.odom.pose.pose
    robot = (p.position.x, p.position.y, p.position.z)
    yaw = yaw_of(p.orientation)
    pts = select_points(cloud_xyz(data.cloud), robot)
    if len(pts) < 100:
        sys.exit(f'only {len(pts)} usable cloud points; cannot judge localization')
    field = likelihood_field(data.map)
    cur = score(field, data.map.info, pts)
    best, dx, dy, dth = search(field, data.map.info, pts, np.array(robot[:2]), radius, yaw_range)
    print(f'pose estimate ({robot[0]:.3f}, {robot[1]:.3f}, {yaw:.3f} rad), {len(pts)} points')
    print(f'fit score {cur:.3f}; best nearby {best:.3f} at correction '
          f'dx={dx:+.2f} m dy={dy:+.2f} m dyaw={math.degrees(dth):+.1f} deg')
    if data.match is not None:
        print(f'robot MATCHING_ERROR: {data.match}')
    return cur, best, (robot[0] + dx, robot[1] + dy, yaw + dth)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('robot', help='robot id, e.g. 834')
    ap.add_argument('--apply', action='store_true', help='send the best correction if it helps')
    ap.add_argument('--pose', nargs=3, type=float, metavar=('X', 'Y', 'YAW'),
                    help='set this pose instead of searching')
    ap.add_argument('--radius', type=float, default=1.0, help='search radius, m')
    ap.add_argument('--yaw-range', type=float, default=20.0, help='search +/- degrees')
    ap.add_argument('--min-gain', type=float, default=0.08,
                    help='score improvement needed before --apply acts')
    a = ap.parse_args()

    rclpy.init()
    node = rclpy.create_node(f'localize_{a.robot}')
    data = Data(node, a.robot)
    wait_for(node, lambda: data.map is not None, 20, f'map on /GRID_MAP_relayed_{a.robot}')

    if a.pose:
        publish_pose(node, a.robot, *a.pose)
        time.sleep(3.0)
        assess(node, data, a.robot, a.radius, math.radians(a.yaw_range))
        return

    cur, best, corrected = assess(node, data, a.robot, a.radius, math.radians(a.yaw_range))
    if best - cur < a.min_gain:
        print('localization looks consistent with the map; nothing to correct')
        return
    if not a.apply:
        print('a better fit exists; rerun with --apply to send it')
        return
    publish_pose(node, a.robot, *corrected)
    time.sleep(3.0)
    assess(node, data, a.robot, a.radius / 2, math.radians(a.yaw_range) / 2)


if __name__ == '__main__':
    main()
