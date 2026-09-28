"""Simulated M20s for rehearsing missions without hardware.

Each mock listens on the UDP port its site entry names (use ip 127.0.0.1 and distinct
ports), answers the vendor protocol the way the adapter expects, walks toward goals
at a fixed speed, and publishes /ODOM_relayed_<id> like the real relay. A pose on
/initialpose_set_relayed_<id> teleports it, mimicking relocalization.

    ros2 run m20_rmf mock_robot --site sites/sim_lab.yaml
"""

import argparse
import math
import socket
import sys
import threading
import time

import rclpy
import rclpy.node
from geometry_msgs.msg import PoseWithCovarianceStamped
from nav_msgs.msg import Odometry

from . import protocol
from .sitefile import Site


class MockM20:
    def __init__(self, rid, port, start, node, speed=0.6, turn_rate=1.2, fail_first_goals=0,
                 publish_odom=True):
        self.rid = rid
        self.x, self.y, self.yaw = start
        self.goal = None     # (value, x, y, yaw)
        self.speed = speed
        self.turn_rate = turn_rate
        self.fail_first_goals = fail_first_goals
        self.publish_odom = publish_odom
        self.last_value = 0
        self.nav_status = 0
        self.lock = threading.Lock()
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(('127.0.0.1', port))
        self.sock.settimeout(0.2)
        self.peer = None
        self.msg_id = 0
        self.node = node
        self.pub = node.create_publisher(Odometry, f'/ODOM_relayed_{rid}', 10)
        node.create_subscription(PoseWithCovarianceStamped, f'/initialpose_set_relayed_{rid}',
                                 self._initialpose, 10)
        threading.Thread(target=self._rx, daemon=True).start()

    def _reply(self, payload):
        if self.peer is not None:
            self.sock.sendto(protocol.encode(payload, self.msg_id), self.peer)
            self.msg_id += 1

    def _rx(self):
        while rclpy.ok():
            try:
                data, peer = self.sock.recvfrom(8192)
            except socket.timeout:
                continue
            self.peer = peer
            payload = protocol.decode(data)
            if not payload:
                continue
            dev = payload['PatrolDevice']
            t, c, items = dev['Type'], dev['Command'], dev.get('Items', {})
            if t == 100:
                self._reply({'PatrolDevice': {'Type': 100, 'Command': 100, 'Items': {'ErrorCode': 0}}})
                self._stream_status()
            elif t == 1003:
                with self.lock:
                    if self.fail_first_goals > 0:
                        self.fail_first_goals -= 1
                        err = 0xA34C
                    elif self.goal is not None:
                        err = 0xA341
                    else:
                        err = 0
                        self.goal = (items['Value'], items['PosX'], items['PosY'], items['AngleYaw'])
                        self.last_value, self.nav_status = items['Value'], 3
                self._reply({'PatrolDevice': {'Type': 1003, 'Command': 1,
                                              'Items': {'ErrorCode': err}}})
            elif t == 1004:
                with self.lock:
                    self.goal = None
                self._reply({'PatrolDevice': {'Type': 1004, 'Command': 1,
                                              'Items': {'ErrorCode': 0x2300}}})
            elif t == 2 and c == 22:
                with self.lock:
                    self.goal = None
                self.node.get_logger().warn(f'[{self.rid}] ESTOP')

    def _stream_status(self):
        # What a real M20 streams after heartbeats (see protocol.Response.status_kind).
        with self.lock:
            loc = {'Location': 1, 'PosX': self.x, 'PosY': self.y, 'PosZ': 0.0, 'Yaw': self.yaw}
            nav = {'Value': self.last_value, 'Status': self.nav_status, 'ErrorCode': 0}
        self._reply({'PatrolDevice': {'Type': 1002, 'Command': 7, 'Items': {
            'NavStatus': nav, 'LocationStatus': loc}}})
        self._reply({'PatrolDevice': {'Type': 1002, 'Command': 5, 'Items': {
            'BatteryList': [{'BatteryLevel': 93}, {'BatteryLevel': 90}]}}})
        self._reply({'PatrolDevice': {'Type': 1002, 'Command': 6, 'Items': {
            'BasicStatus': {'Sleep': 0, 'MotionState': 1}}}})

    def _initialpose(self, msg):
        p = msg.pose.pose
        with self.lock:
            self.x, self.y = p.position.x, p.position.y
            self.yaw = math.atan2(2 * p.orientation.w * p.orientation.z,
                                  1 - 2 * p.orientation.z ** 2)
        self.node.get_logger().info(f'[{self.rid}] relocalized to ({self.x:.2f}, {self.y:.2f})')

    def step(self, dt):
        done = None
        with self.lock:
            if self.goal is not None:
                value, gx, gy, gyaw = self.goal
                d = math.hypot(gx - self.x, gy - self.y)
                if d > 0.02:
                    heading = math.atan2(gy - self.y, gx - self.x)
                    s = min(d, self.speed * dt)
                    self.x += s * math.cos(heading)
                    self.y += s * math.sin(heading)
                    self.yaw = heading
                else:
                    err = math.atan2(math.sin(gyaw - self.yaw), math.cos(gyaw - self.yaw))
                    if abs(err) > 0.02:
                        self.yaw += max(-self.turn_rate * dt, min(self.turn_rate * dt, err))
                    else:
                        self.x, self.y, self.yaw = gx, gy, gyaw
                        self.goal = None
                        self.nav_status = 4
                        done = value
            m = Odometry()
            m.header.stamp = self.node.get_clock().now().to_msg()
            m.header.frame_id = 'map'
            m.child_frame_id = f'{self.rid}/base_link'
            m.pose.pose.position.x = self.x
            m.pose.pose.position.y = self.y
            m.pose.pose.orientation.z = math.sin(self.yaw / 2)
            m.pose.pose.orientation.w = math.cos(self.yaw / 2)
        if self.publish_odom:
            self.pub.publish(m)
        if done is not None:
            self._reply({'PatrolDevice': {'Type': 1007, 'Command': 1,
                                          'Items': {'Value': done, 'Status': 4, 'ErrorCode': 0}}})


def main(argv=sys.argv):
    from . import domain_guard
    domain_guard.check(argv=argv)
    rclpy.init(args=argv)
    args_ = rclpy.utilities.remove_ros_args(argv)
    p = argparse.ArgumentParser(prog='mock_robot')
    p.add_argument('--site', required=True)
    p.add_argument('--robots', default='')
    p.add_argument('--speed', type=float, default=0.6)
    p.add_argument('--start', default='home', help='"home" or a place name for all robots')
    p.add_argument('--no-odom', action='store_true',
                   help='do not publish /ODOM_relayed_<id> (tests the UDP pose fallback)')
    p.add_argument('--fail-first-goals', type=int, default=0,
                   help='reject this many goals with a planning error (tests retries)')
    a = p.parse_args(args_[1:])
    site = Site.load(a.site)
    node = rclpy.node.Node('m20_mock_robots')
    wanted = [r for r in a.robots.split(',') if r] or site.robot_ids()
    mocks = []
    for rid in wanted:
        cfg = site.robots[rid]
        if cfg['ip'] not in ('127.0.0.1', 'localhost'):
            sys.exit(f'robot {rid} has ip {cfg["ip"]}; mocks only run on 127.0.0.1')
        start = site.place(cfg['home'] if a.start == 'home' else a.start)
        mocks.append(MockM20(rid, int(cfg['port']), start, node, a.speed,
                             fail_first_goals=a.fail_first_goals, publish_odom=not a.no_odom))
        node.get_logger().info(f'mock {rid} on udp {cfg["port"]} at {start}')

    def loop():
        while rclpy.ok():
            for m in mocks:
                m.step(0.05)
            time.sleep(0.05)
    threading.Thread(target=loop, daemon=True).start()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    rclpy.try_shutdown()


if __name__ == '__main__':
    main()
