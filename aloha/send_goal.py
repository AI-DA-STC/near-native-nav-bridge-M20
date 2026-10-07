#!/usr/bin/env python3
"""Drive the Aloha through the waypoints in a demo JSON file with move_base, one after another, and exit once
the last is reached: send_goal.py <file.json> [--dock]. move_base stops anywhere within 25 cm of a waypoint; --dock then
has dock.py on the robot put the base precisely on the last one. Run with the bridge's ROS_DOMAIN_ID. Ctrl+C sends no
more waypoints; the Aloha still drives to (or docks onto) the one it has."""

import json
import math
import sys
import time

import rclpy
from actionlib_msgs.msg import GoalStatus, GoalStatusArray
from geometry_msgs.msg import PoseStamped
from rclpy.node import Node
from rclpy.utilities import remove_ros_args

WP_TIMEOUT_S = 125.0
ACCEPT_TIMEOUT_S = 10.0
DOCK_TIMEOUT_S = 90.0  # dock.py gives up after 60 s, plus its AMCL refreshes
DONE = {GoalStatus.SUCCEEDED, GoalStatus.ABORTED, GoalStatus.REJECTED, GoalStatus.PREEMPTED,
        GoalStatus.RECALLED, GoalStatus.LOST}
NAMES = {v: k for k, v in vars(GoalStatus).items() if k.isupper() and isinstance(v, int)}


class AlohaGoal(Node):
    def __init__(self):
        super().__init__("aloha_goal")
        self.goal_pub = self.create_publisher(PoseStamped, "/move_base_simple/goal", 10)
        self.goals = None  # goal id -> latest move_base status, once move_base has reported
        self.create_subscription(GoalStatusArray, "/move_base/status", self._status_cb, 10)
        self.dock_pub = self.create_publisher(PoseStamped, "/aloha/dock/goal", 10)
        self.docks = {}  # dock goal stamp -> latest status from dock.py
        self.create_subscription(GoalStatus, "/aloha/dock/result", self._dock_cb, 10)

    def _status_cb(self, msg):
        self.goals = {**(self.goals or {}), **{s.goal_id.id: s.status for s in msg.status_list}}

    def _dock_cb(self, msg):
        self.docks[(msg.goal_id.stamp.sec, msg.goal_id.stamp.nanosec)] = msg

    def wait(self, condition, timeout=math.inf):
        end = time.monotonic() + timeout
        while rclpy.ok() and time.monotonic() < end:
            rclpy.spin_once(self, timeout_sec=0.1)
            result = condition()
            if result is not None:
                return result
        return None


def waypoint(wp):
    goal = PoseStamped()
    goal.header.frame_id = "map"
    goal.pose.position.x, goal.pose.position.y = float(wp["x"]), float(wp["y"])
    goal.pose.orientation.z, goal.pose.orientation.w = math.sin(wp["yaw"] / 2), math.cos(wp["yaw"] / 2)
    return goal


def dock(node, rid, wp):
    if node.wait(lambda: True if node.dock_pub.get_subscription_count() else None, 5.0) is None:
        sys.exit("[ALOHA] Nothing takes /aloha/dock/goal: restart aloha/bridge.sh, which now bridges it")
    goal = waypoint(wp)
    goal.header.stamp = node.get_clock().now().to_msg()
    key = (goal.header.stamp.sec, goal.header.stamp.nanosec)
    final = lambda: node.docks[key] if key in node.docks and node.docks[key].status != GoalStatus.ACTIVE else None
    print(f"[ALOHA] Robot {rid} docking onto its last WP")
    started = time.monotonic()
    node.dock_pub.publish(goal)
    while (status := node.wait(final, 2.0)) is None:
        waited = time.monotonic() - started
        if key not in node.docks and waited > ACCEPT_TIMEOUT_S:
            sys.exit(f"[ALOHA] No answer from dock.py on the robot within {ACCEPT_TIMEOUT_S:.0f} s: is it running, "
                     "in start_aloha.sh's dock window?")
        if waited > DOCK_TIMEOUT_S:
            sys.exit(f"[ALOHA] Robot {rid} not docked after {DOCK_TIMEOUT_S:.0f} s")
        node.dock_pub.publish(goal)  # again, as an answer can get lost: dock.py answers each time
    if status.status != GoalStatus.SUCCEEDED:
        sys.exit(f"[ALOHA] Robot {rid} docking failed: {status.text}")
    print(f"[ALOHA] Robot {rid} docked: {status.text}")


def main():
    args = remove_ros_args(sys.argv)[1:]
    docking = "--dock" in args
    args = [a for a in args if a != "--dock"]
    if len(args) != 1:
        sys.exit(__doc__)
    with open(args[0]) as f:
        routes = json.load(f)
    if len(routes) != 1:
        sys.exit(f"[ALOHA] {args[0]} must hold exactly one robot, it holds {', '.join(routes)}")
    rid, route = next(iter(routes.items()))

    rclpy.init(args=sys.argv)
    node = AlohaGoal()
    try:
        ready = lambda: True if node.goal_pub.get_subscription_count() and node.goals is not None else None
        if node.wait(ready, 5.0) is None:
            print("[ALOHA] Waiting for move_base on /move_base/status and /move_base_simple/goal (is aloha/bridge.sh "
                  "running, on this ROS_DOMAIN_ID?)")
            node.wait(ready)
        started = time.monotonic()
        for n, wp in enumerate(route, 1):
            known = set(node.goals)
            node.goal_pub.publish(waypoint(wp))
            print(f"[ALOHA] Robot {rid} → WP {n}/{len(route)}: x={wp['x']:.3f} y={wp['y']:.3f} "
                  f"yaw={math.degrees(wp['yaw']):.1f}deg")
            gid = node.wait(lambda: next((g for g in node.goals if g not in known), None), ACCEPT_TIMEOUT_S)
            if gid is None:
                sys.exit(f"[ALOHA] move_base did not take WP {n} within {ACCEPT_TIMEOUT_S:.0f} s")
            state = node.wait(lambda: node.goals[gid] if node.goals[gid] in DONE else None, WP_TIMEOUT_S)
            if state != GoalStatus.SUCCEEDED:
                outcome = NAMES[state] if state is not None else f"not reached after {WP_TIMEOUT_S:.0f} s"
                sys.exit(f"[ALOHA] Robot {rid} WP {n}/{len(route)} {outcome}")
            print(f"[ALOHA] Robot {rid} WP {n}/{len(route)} SUCCEEDED")
        if docking:
            dock(node, rid, route[-1])
        print(f"[ALOHA] Robot {rid} finished its route in {time.monotonic() - started:.0f} s")
    except KeyboardInterrupt:
        pass
    finally:
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
