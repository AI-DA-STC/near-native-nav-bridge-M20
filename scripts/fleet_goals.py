#!/usr/bin/env python3
"""fleet_goals.py — start every robot on its own goal at the same instant.

Draw one RViz2 "2D Goal Pose" arrow per robot, in the order the robot ids are given,
then press ENTER here: all goals are published on /goal_pose_<id> back to back, so every
`nav_cmd_bridge bridge` terminal (plain bridge mode) sets off its robot together.

RViz2's arrows must arrive on /fleet_goal. No bridge listens there, so drawing an arrow
never moves a robot by itself; only ENTER does.
"""

import argparse
import math
import sys
import threading

import rclpy
from rclpy.node import Node
from rclpy.utilities import remove_ros_args
from geometry_msgs.msg import PoseStamped
from visualization_msgs.msg import Marker, MarkerArray

ARROW_TOPIC  = "/fleet_goal"
MARKER_TOPIC = "/fleet_goal_markers"
COLORS = [(0.3, 0.6, 1.0), (1.0, 0.6, 0.2), (0.9, 0.3, 0.9), (0.3, 0.9, 0.4)]


def _quat_to_yaw(q):
    return math.atan2(2.0 * (q.w * q.z + q.x * q.y), 1.0 - 2.0 * (q.y * q.y + q.z * q.z))


class FleetGoals(Node):
    def __init__(self, robot_ids):
        super().__init__("fleet_goals")
        self.robot_ids = robot_ids
        self.lock = threading.Lock()
        self.pending = {}  # robot id -> PoseStamped, filled in robot_ids order; guarded by lock
        self.goal_pubs = {rid: self.create_publisher(PoseStamped, f"/goal_pose_{rid}", 10) for rid in robot_ids}
        self.marker_pub = self.create_publisher(MarkerArray, MARKER_TOPIC, 10)
        self.create_subscription(PoseStamped, ARROW_TOPIC, self._arrow_cb, 10)
        # re-sent so a MarkerArray display added later still shows the pending goals
        self.create_timer(1.0, self._publish_markers)

    def _arrow_cb(self, msg):
        with self.lock:
            free = [rid for rid in self.robot_ids if rid not in self.pending]
            if free:
                self.pending[free[0]] = msg
            count = len(self.pending)
        if not free:
            print("[FLEET] Every robot already has a goal: ENTER sends them, c + ENTER clears")
            return
        p = msg.pose.position
        print(f"[FLEET] Robot {free[0]}: x={p.x:.3f} y={p.y:.3f} "
              f"yaw={math.degrees(_quat_to_yaw(msg.pose.orientation)):.1f}deg ({count}/{len(self.robot_ids)})")
        self._publish_markers()

    # All or nothing: a robot without an arrow, or without a bridge listening, holds everyone back.
    def send_all(self):
        with self.lock:
            missing = [rid for rid in self.robot_ids if rid not in self.pending]
            deaf = [rid for rid in self.robot_ids if self.goal_pubs[rid].get_subscription_count() == 0]
            goals = None
            if not missing and not deaf:
                goals, self.pending = self.pending, {}
        if missing:
            print(f"[FLEET] Not sent: no arrow yet for robot {', '.join(missing)}")
        if deaf:
            print(f"[FLEET] Not sent: nothing listens on {', '.join('/goal_pose_' + rid for rid in deaf)} "
                  "(is that bridge running, with ROBOT_ID exported?)")
        if goals is None:
            return
        # back to back, so every bridge receives its goal within the same few milliseconds
        for rid in self.robot_ids:
            self.goal_pubs[rid].publish(goals[rid])
        print(f"[FLEET] Sent: robots {', '.join(self.robot_ids)} are starting")
        self._publish_markers()

    def clear(self):
        with self.lock:
            self.pending = {}
        print("[FLEET] Cleared all arrows")
        self._publish_markers()

    # One arrow + robot id per pending goal, coloured per robot.
    def _publish_markers(self):
        arr = MarkerArray(markers=[Marker(action=Marker.DELETEALL)])
        with self.lock:
            goals = dict(self.pending)
        for i, rid in enumerate(self.robot_ids):
            goal = goals.get(rid)
            if goal is None:
                continue
            arrow = Marker(header=goal.header, ns="arrows", id=i, type=Marker.ARROW, pose=goal.pose)
            arrow.scale.x, arrow.scale.y, arrow.scale.z = 0.6, 0.1, 0.1
            arrow.color.r, arrow.color.g, arrow.color.b = COLORS[i % len(COLORS)]
            arrow.color.a = 1.0
            label = Marker(header=goal.header, ns="labels", id=i, type=Marker.TEXT_VIEW_FACING, text=rid)
            label.pose.position.x = goal.pose.position.x
            label.pose.position.y = goal.pose.position.y
            label.pose.position.z = 0.4
            label.pose.orientation.w = 1.0
            label.scale.z = 0.3
            label.color.r = label.color.g = label.color.b = label.color.a = 1.0
            arr.markers += [arrow, label]
        self.marker_pub.publish(arr)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("robot_ids", nargs="+",
                        help="Robot ids in the order their arrows will be drawn, e.g. 741 665 834")
    args = parser.parse_args(remove_ros_args(sys.argv)[1:])

    rclpy.init(args=sys.argv)
    node = FleetGoals(args.robot_ids)
    threading.Thread(target=rclpy.spin, args=(node,), daemon=True).start()
    print(f"[FLEET] Arrows on {ARROW_TOPIC} go to robots {', '.join(args.robot_ids)} in that order; "
          f"pending goals are drawn on {MARKER_TOPIC}")
    try:
        while rclpy.ok():
            print("\n>>> Draw one arrow per robot in RViz2, then ENTER to send them all at once "
                  "(c + ENTER clears) <<<\n")
            if input().strip().lower() == "c":
                node.clear()
            else:
                node.send_all()
    except (EOFError, KeyboardInterrupt):
        pass
    finally:
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
