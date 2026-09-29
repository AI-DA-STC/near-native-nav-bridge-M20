#!/usr/bin/env python3
"""fleet_management.py — start every robot on its own goal(s) at the same instant.

Modes (first argument):
  single-waypoint        Draw one RViz2 "2D Goal Pose" arrow per robot, in the order the robot ids
                         are given, then press ENTER: all goals are published on /goal_pose_<id> back
                         to back, so every robot sets off together.
  multi-waypoint         Draw each robot's waypoints in order, n + ENTER moves on to the next robot,
                         then ENTER: every robot sets off for its first waypoint together and works
                         through the rest on its own, like `bridge queue`. A robot's next waypoint is
                         sent once its bridge reports on /goal_result_<id> that the robot has finished
                         the current one, or gave up on it after 120 s.
  multi-waypoint-patrol  Like multi-waypoint, but each robot's waypoints must form a closed shape
                         (3 or more, e.g. the corners of a square in order): after its last waypoint
                         a robot drives back to WP1 and loops, until s + ENTER or Ctrl+C.

Every robot runs `nav_cmd_bridge bridge` (plain bridge mode). RViz2's arrows must arrive on
/fleet_goal. No bridge listens there, so drawing an arrow never moves a robot by itself; only ENTER does.
"""

import argparse
import math
import sys
import threading
import time

import rclpy
from rclpy.node import Node
from rclpy.utilities import remove_ros_args
from geometry_msgs.msg import Point, PoseStamped
from nav_msgs.msg import Odometry
from std_msgs.msg import String
from visualization_msgs.msg import Marker, MarkerArray

MODES        = ("single-waypoint", "multi-waypoint", "multi-waypoint-patrol")
ARROW_TOPIC  = "/fleet_goal"
MARKER_TOPIC = "/fleet_goal_markers"
COLORS = [(0.3, 0.6, 1.0), (1.0, 0.6, 0.2), (0.9, 0.3, 0.9), (0.3, 0.9, 0.4)]

# Just past the bridge's own 120 s timeout, so its thread for this waypoint has given up first.
WP_TIMEOUT_S = 125.0


def _quat_to_yaw(q):
    return math.atan2(2.0 * (q.w * q.z + q.x * q.y), 1.0 - 2.0 * (q.y * q.y + q.z * q.z))


def _describe(goal):
    p = goal.pose.position
    return f"x={p.x:.3f} y={p.y:.3f} yaw={math.degrees(_quat_to_yaw(goal.pose.orientation)):.1f}deg"


# An arrow at the goal plus a text label above it.
def _goal_markers(goal, marker_id, color, text, alpha=1.0):
    arrow = Marker(header=goal.header, ns="arrows", id=marker_id, type=Marker.ARROW, pose=goal.pose)
    arrow.scale.x, arrow.scale.y, arrow.scale.z = 0.6, 0.1, 0.1
    arrow.color.r, arrow.color.g, arrow.color.b = color
    arrow.color.a = alpha
    label = Marker(header=goal.header, ns="labels", id=marker_id, type=Marker.TEXT_VIEW_FACING, text=text)
    label.pose.position.x = goal.pose.position.x
    label.pose.position.y = goal.pose.position.y
    label.pose.position.z = 0.4
    label.pose.orientation.w = 1.0
    label.scale.z = 0.3
    label.color.r = label.color.g = label.color.b = 1.0
    label.color.a = alpha
    return [arrow, label]


class SingleWaypointFleet(Node):
    prompt = "Draw one arrow per robot in RViz2, then ENTER to send them all at once (c + ENTER clears)"

    def __init__(self, robot_ids):
        super().__init__("fleet_management")
        self.robot_ids = robot_ids
        self.lock = threading.Lock()
        self.pending = {}  # robot id -> PoseStamped, filled in robot_ids order; guarded by lock
        self.goal_pubs = {rid: self.create_publisher(PoseStamped, f"/goal_pose_{rid}", 10) for rid in robot_ids}
        self.marker_pub = self.create_publisher(MarkerArray, MARKER_TOPIC, 10)
        self.create_subscription(PoseStamped, ARROW_TOPIC, self._arrow_cb, 10)
        # re-sent so a MarkerArray display added later still shows the pending goals
        self.create_timer(1.0, self._publish_markers)

    def command(self, line):
        if line == "c":
            self.clear()
        else:
            self.send_all()

    def _arrow_cb(self, msg):
        with self.lock:
            free = [rid for rid in self.robot_ids if rid not in self.pending]
            if free:
                self.pending[free[0]] = msg
            count = len(self.pending)
        if not free:
            print("[FLEET] Every robot already has a goal: ENTER sends them, c + ENTER clears")
            return
        print(f"[FLEET] Robot {free[0]}: {_describe(msg)} ({count}/{len(self.robot_ids)})")
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
            if rid in goals:
                arr.markers += _goal_markers(goals[rid], i, COLORS[i % len(COLORS)], rid)
        self.marker_pub.publish(arr)


class MultiWaypointFleet(Node):
    def __init__(self, robot_ids, patrol=False):
        super().__init__("fleet_management")
        self.robot_ids = robot_ids
        self.patrol = patrol
        self.min_wps = 3 if patrol else 1  # a patrol loops a closed shape, so it needs a polygon
        self.prompt = ("Draw the current robot's waypoints in RViz2 in order. n + ENTER: next robot, "
                       "u + ENTER: undo its last arrow, c + ENTER: clear all, ENTER: start every robot")
        if patrol:
            self.prompt += ", s + ENTER: stop the patrols"
        self.lock = threading.Lock()  # guards every member below
        self.pending = {rid: [] for rid in robot_ids}  # routes being drawn, not sent yet
        self.current = 0   # index in robot_ids that new arrows go to
        self.routes = {}   # robot id -> route being driven; removed once finished
        self.next_wp = {}  # robot id -> index in its route of the waypoint being driven to
        self.sent_at = {}  # robot id -> monotonic time that waypoint was sent
        self.laps = {}     # robot id -> patrol lap being driven
        self.stopping = False  # patrol only: robots stop at the waypoint they are driving to
        self.odom = {}     # robot id -> latest (x, y) on /ODOM_relayed_<id>
        self.goal_pubs = {rid: self.create_publisher(PoseStamped, f"/goal_pose_{rid}", 10) for rid in robot_ids}
        for rid in robot_ids:
            self.create_subscription(Odometry, f"/ODOM_relayed_{rid}",
                                     lambda msg, rid=rid: self._odom_cb(rid, msg), 10)
            self.create_subscription(String, f"/goal_result_{rid}",
                                     lambda msg, rid=rid: self._result_cb(rid, msg), 10)
        self.marker_pub = self.create_publisher(MarkerArray, MARKER_TOPIC, 10)
        self.create_subscription(PoseStamped, ARROW_TOPIC, self._arrow_cb, 10)
        # timeouts, and markers re-sent so a MarkerArray display added later still shows the routes
        self.create_timer(1.0, self._tick)

    def command(self, line):
        if line == "n":
            self.next_robot()
        elif line == "u":
            self.undo()
        elif line == "c":
            self.clear()
        elif line == "s" and self.patrol:
            self.stop()
        elif line == "":
            self.send_all()
        else:
            print(f"[FLEET] Unknown command '{line}'")

    def _arrow_cb(self, msg):
        with self.lock:
            rid = self.robot_ids[self.current]
            self.pending[rid].append(msg)
            count = len(self.pending[rid])
        print(f"[FLEET] Robot {rid} WP {count}: {_describe(msg)}")
        self._publish_markers()

    def next_robot(self):
        with self.lock:
            self.current = (self.current + 1) % len(self.robot_ids)
            rid = self.robot_ids[self.current]
            count = len(self.pending[rid])
        print(f"[FLEET] Arrows now go to robot {rid} ({count} WP so far)")

    def undo(self):
        with self.lock:
            rid = self.robot_ids[self.current]
            dropped = self.pending[rid].pop() if self.pending[rid] else None
            count = len(self.pending[rid])
        if dropped is None:
            print(f"[FLEET] Robot {rid} has no arrows to undo")
        else:
            print(f"[FLEET] Robot {rid}: dropped WP {count + 1}, {count} left")
        self._publish_markers()

    def clear(self):
        with self.lock:
            self.pending = {rid: [] for rid in self.robot_ids}
            self.current = 0
        print(f"[FLEET] Cleared all arrows; arrows go to robot {self.robot_ids[0]}")
        self._publish_markers()

    def stop(self):
        with self.lock:
            driving = [rid for rid in self.robot_ids if rid in self.routes]
            self.stopping = bool(driving)
        if driving:
            print(f"[FLEET] Stopping: robot {', '.join(driving)} stop at the waypoint they are driving to")
        else:
            print("[FLEET] No patrol running")

    # All or nothing: a robot without enough waypoints, without a bridge listening, without odometry,
    # or still driving its previous route holds everyone back.
    def send_all(self):
        with self.lock:
            missing = [rid for rid in self.robot_ids if len(self.pending[rid]) < self.min_wps]
            deaf = [rid for rid in self.robot_ids if self.goal_pubs[rid].get_subscription_count() == 0]
            no_odom = [rid for rid in self.robot_ids if rid not in self.odom]
            busy = [rid for rid in self.robot_ids if rid in self.routes]
            sent = not (missing or deaf or no_odom or busy)
            if sent:
                self.routes, self.pending = self.pending, {rid: [] for rid in self.robot_ids}
                self.current = 0
                now = time.monotonic()
                self.next_wp = {rid: 0 for rid in self.robot_ids}
                self.sent_at = {rid: now for rid in self.robot_ids}
                self.laps = {rid: 1 for rid in self.robot_ids}
                self.stopping = False
                # back to back, so every bridge receives its first waypoint within the same few milliseconds
                for rid in self.robot_ids:
                    self.goal_pubs[rid].publish(self.routes[rid][0])
                sizes = ", ".join(f"{rid} ({len(self.routes[rid])} WP)" for rid in self.robot_ids)
        if missing and self.patrol:
            print(f"[FLEET] Not sent: robot {', '.join(missing)} has fewer than {self.min_wps} waypoints "
                  "(a patrol loops a closed shape)")
        elif missing:
            print(f"[FLEET] Not sent: no waypoints yet for robot {', '.join(missing)}")
        if deaf:
            print(f"[FLEET] Not sent: nothing listens on {', '.join('/goal_pose_' + rid for rid in deaf)} "
                  "(is that bridge running, with ROBOT_ID exported?)")
        if no_odom:
            print(f"[FLEET] Not sent: no odometry yet on {', '.join('/ODOM_relayed_' + rid for rid in no_odom)}")
        if busy:
            print(f"[FLEET] Not sent: robot {', '.join(busy)} still driving its route"
                  + (" (s + ENTER stops the patrols)" if self.patrol else ""))
        if sent:
            print(f"[FLEET] Sent: {sizes} are starting")
        self._publish_markers()

    def _odom_cb(self, rid, msg):
        p = msg.pose.pose.position
        with self.lock:
            self.odom[rid] = (p.x, p.y)

    def _result_cb(self, rid, msg):
        with self.lock:
            if rid not in self.routes:
                return
            self._advance(rid, msg.data)
        self._publish_markers()

    def _tick(self):
        with self.lock:
            now = time.monotonic()
            for rid in [rid for rid in self.routes if now - self.sent_at[rid] > WP_TIMEOUT_S]:
                self._advance(rid, "TIMEOUT")
        self._publish_markers()

    # Caller holds the lock. Sends the robot's next waypoint (a patrol wraps from the last back
    # to WP1), or retires its route once finished or stopped.
    def _advance(self, rid, outcome):
        route, i = self.routes[rid], self.next_wp[rid]
        x, y = self.odom[rid]
        print(f"[FLEET] Robot {rid} WP {i + 1}/{len(route)} {outcome} — actual x={x:.3f} y={y:.3f}")
        if self.stopping or (i + 1 == len(route) and not self.patrol):
            laps = self.laps[rid]
            del self.routes[rid], self.next_wp[rid], self.sent_at[rid], self.laps[rid]
            print(f"[FLEET] Robot {rid} stopped at WP {i + 1}, lap {laps}" if self.patrol
                  else f"[FLEET] Robot {rid} finished its route")
            return
        nxt = (i + 1) % len(route)
        if nxt == 0:
            self.laps[rid] += 1
            print(f"[FLEET] Robot {rid} lap {self.laps[rid]}")
        self.next_wp[rid] = nxt
        self.sent_at[rid] = time.monotonic()
        self.goal_pubs[rid].publish(route[nxt])
        print(f"[FLEET] Robot {rid} → WP {nxt + 1}/{len(route)}: {_describe(route[nxt])}")

    # Per robot, coloured: routes being drawn as numbered arrows joined by a line (closed back to
    # WP1 for a patrol), and what is left of a route being driven, dimmed (all of it for a patrol).
    def _publish_markers(self):
        arr = MarkerArray(markers=[Marker(action=Marker.DELETEALL)])
        with self.lock:
            drawn = [(rid, list(self.pending[rid]), 0, 1.0) for rid in self.robot_ids]
            drawn += [(rid, list(self.routes[rid]), 0 if self.patrol else self.next_wp[rid], 0.4)
                      for rid in self.robot_ids if rid in self.routes]
        marker_id = 0
        for rid, route, start, alpha in drawn:
            color = COLORS[self.robot_ids.index(rid) % len(COLORS)]
            for n in range(start, len(route)):
                arr.markers += _goal_markers(route[n], marker_id, color, f"{rid}·{n + 1}", alpha)
                marker_id += 1
            corners = route[start:] + (route[:1] if self.patrol and len(route) >= 3 else [])
            if len(corners) >= 2:
                line = Marker(header=route[start].header, ns="routes", id=marker_id, type=Marker.LINE_STRIP)
                line.points = [Point(x=g.pose.position.x, y=g.pose.position.y) for g in corners]
                line.pose.orientation.w = 1.0
                line.scale.x = 0.03
                line.color.r, line.color.g, line.color.b = color
                line.color.a = alpha
                arr.markers.append(line)
                marker_id += 1
        self.marker_pub.publish(arr)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("mode", choices=MODES)
    parser.add_argument("robot_ids", nargs="+",
                        help="Robot ids in the order their arrows will be drawn, e.g. 741 665 834")
    args = parser.parse_args(remove_ros_args(sys.argv)[1:])
    patrol = args.mode == "multi-waypoint-patrol"

    rclpy.init(args=sys.argv)
    if args.mode == "single-waypoint":
        node = SingleWaypointFleet(args.robot_ids)
    else:
        node = MultiWaypointFleet(args.robot_ids, patrol=patrol)
    threading.Thread(target=rclpy.spin, args=(node,), daemon=True).start()
    print(f"[FLEET] {args.mode}: arrows on {ARROW_TOPIC} go to robots {', '.join(args.robot_ids)} in that "
          f"order; pending goals are drawn on {MARKER_TOPIC}")
    if patrol:
        print("\n[FLEET] !!! PATROL: mark each robot's waypoints as a CLOSED SHAPE, at least 3, in order around it\n"
              "[FLEET] !!! (e.g. the 4 corners of a square: WP1 → WP2 → WP3 → WP4). After its last waypoint a robot\n"
              "[FLEET] !!! drives straight back to WP1 and loops until s + ENTER or Ctrl+C. Do not redraw WP1 at\n"
              "[FLEET] !!! the end: the closing leg WP4 → WP1 is added for you and drawn in RViz2.")
    try:
        while rclpy.ok():
            print(f"\n>>> {node.prompt} <<<\n")
            node.command(input().strip().lower())
    except (EOFError, KeyboardInterrupt):
        pass
    finally:
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
