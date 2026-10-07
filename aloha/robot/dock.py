#!/usr/bin/env python3
"""Precise docking of the Aloha (Ranger Mini V2) onto a pose in the map, run on the robot: python3 dock.py
move_base stops anywhere within 25 cm and 0.1 rad of its goal (DWAPlannerROS xy/yaw_goal_tolerance), too loose for the
taught arm poses. After it, send_goal.py --dock sends the same pose on /aloha/dock/goal (PoseStamped in map, through
aloha/bridge.sh) and this drives base_link onto it: it refreshes AMCL (request_nomotion_update), spins in place to the
goal heading, crabs (parallel mode, wheels up to 90 deg) straight onto the goal position, and checks again, until within
xy_tol and yaw_tol, or for 3 corrections at most. /aloha/dock/result answers ACTIVE, then SUCCEEDED or ABORTED with the
error left. Ctrl+C stops the base. Tolerances and speeds are private params, e.g. python3 dock.py _v_min:=0.03"""

import math
import queue
import signal
import sys

import rospy
import tf2_ros
from actionlib_msgs.msg import GoalStatus
from geometry_msgs.msg import PoseStamped, Twist, Vector3
from std_srvs.srv import Empty

RATE = 20  # Hz: commands to the base
SETTLE_S = 0.8  # after stopping, for the base to stop and the laser odometry (10 Hz) to catch up
STALL_S = 3.0  # no progress for this long: the base is not moving (blocked, or under its deadband)
ATTEMPTS = 3  # corrections (AMCL refresh, spin, crab, spin) at most, then it stops where it is
HYST = 0.17  # rad: past 90 deg by this, crabbing switches between driving forward and backward


class DockError(Exception):
    pass


def wrap(a):
    return math.atan2(math.sin(a), math.cos(a))


def yaw_of(q):
    return math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z))


class Dock:
    def __init__(self):
        p = lambda name, default: rospy.get_param("~" + name, default)
        self.xy_tol, self.yaw_tol = p("xy_tol", 0.015), p("yaw_tol", 0.012)  # m, rad (0.7 deg)
        self.max_xy, self.max_yaw = p("max_xy", 0.5), p("max_yaw", 0.5)  # further off, move_base did not get there
        self.v_min, self.v_max, self.k_v = p("v_min", 0.02), p("v_max", 0.08), p("k_v", 0.8)  # m/s, m/s, 1/s
        self.w_min, self.w_max, self.k_w = p("w_min", 0.05), p("w_max", 0.3), p("k_w", 1.0)  # rad/s, rad/s, 1/s
        self.timeout = p("timeout", 60.0)  # s, per goal
        self.tf = tf2_ros.Buffer()
        self.tf_listener = tf2_ros.TransformListener(self.tf)
        self.cmd = rospy.Publisher("/cmd_vel", Twist, queue_size=1)
        self.result = rospy.Publisher("/aloha/dock/result", GoalStatus, queue_size=10, latch=True)
        self.nomotion = rospy.ServiceProxy("/request_nomotion_update", Empty)
        self.rate = rospy.Rate(RATE)
        self.goals = queue.Queue()
        self.last = None  # GoalStatus of the latest goal
        rospy.Subscriber("/aloha/dock/goal", PoseStamped, self.on_goal, queue_size=10)

    def on_goal(self, goal):
        last = self.last
        if last is not None and last.goal_id.stamp == goal.header.stamp:
            self.result.publish(last)  # sent again: answer again, the answer may have been lost
        else:
            self.goals.put(goal)

    def run(self):
        rospy.loginfo("Waiting for goals on /aloha/dock/goal")
        while not rospy.is_shutdown():
            try:
                goal = self.goals.get(timeout=0.5)
            except queue.Empty:
                continue
            if self.last is not None and self.last.goal_id.stamp == goal.header.stamp:
                self.result.publish(self.last)
                continue
            self.answer(goal, GoalStatus.ACTIVE, "docking")
            q, p = goal.pose.orientation, goal.pose.position
            target = (p.x, p.y, yaw_of(q))
            rospy.loginfo("Docking onto x=%.3f y=%.3f yaw=%.1f deg", p.x, p.y, math.degrees(target[2]))
            try:
                if goal.header.frame_id not in ("", "map"):
                    raise DockError(f"the goal is in {goal.header.frame_id}, not map")
                status, text = GoalStatus.SUCCEEDED, self.dock(target)
                rospy.loginfo("Docked: %s", text)
            except (DockError, tf2_ros.TransformException) as e:
                status, text = GoalStatus.ABORTED, str(e)
                rospy.logwarn("Docking failed: %s", text)
            finally:
                self.stop(settle=False)
            self.answer(goal, status, text)

    def answer(self, goal, status, text):
        msg = GoalStatus(status=status, text=text)
        msg.goal_id.stamp, msg.goal_id.id = goal.header.stamp, "dock"
        self.last = msg
        self.result.publish(msg)

    def dock(self, target):
        deadline = rospy.Time.now() + rospy.Duration(self.timeout)
        for attempt in range(ATTEMPTS + 1):
            self.refresh()
            ex, ey, eth = self.error(target)
            d = math.hypot(ex, ey)
            off = f"{d * 100:.1f} cm and {math.degrees(abs(eth)):.2f} deg off"
            if d <= self.xy_tol and abs(eth) <= self.yaw_tol:
                return f"{off}, after {attempt} correction(s)"
            if attempt == ATTEMPTS:
                return f"{off}, after {ATTEMPTS} corrections (the most it makes)"
            if d > self.max_xy or abs(eth) > self.max_yaw:
                raise DockError(f"{off}: too far to dock, move_base did not get there")
            rospy.loginfo("Correction %d: %s", attempt + 1, off)
            if abs(eth) > self.yaw_tol:
                self.turn(target, deadline)
            if math.hypot(*self.error(target)[:2]) > self.xy_tol:
                self.crab(target, deadline)
            if abs(self.error(target)[2]) > self.yaw_tol:
                self.turn(target, deadline)

    def refresh(self):  # AMCL updates on the spot, for its best estimate of where the base stands
        for _ in range(3):
            try:
                self.nomotion()
            except (rospy.ServiceException, rospy.ROSException) as e:
                rospy.logwarn_once("No AMCL refresh (%s): docking on its current estimate", e)
                return
            rospy.sleep(0.3)  # AMCL updates on its next scan (10 Hz)
        # AMCL stamps map -> odom transform_tolerance into the future, so TF only shows its update that long after
        rospy.sleep(rospy.get_param("/amcl/transform_tolerance", 0.1) + 0.3)

    def error(self, target):  # the goal position in base_link, and the heading error
        t = self.tf.lookup_transform("map", "base_link", rospy.Time(0), rospy.Duration(1.0))
        if (rospy.Time.now() - t.header.stamp).to_sec() > 0.5:
            raise DockError("map -> base_link is over 0.5 s old: is the laser odometry (rf2o) running?")
        yaw = yaw_of(t.transform.rotation)
        dx, dy = target[0] - t.transform.translation.x, target[1] - t.transform.translation.y
        return math.cos(yaw) * dx + math.sin(yaw) * dy, -math.sin(yaw) * dx + math.cos(yaw) * dy, wrap(target[2] - yaw)

    def progress(self, err, best, since, step, doing, deadline, speed):  # the lowest error yet and since when
        now = rospy.Time.now()
        if now > deadline:
            raise DockError(f"out of time ({self.timeout:.0f} s) while {doing}")
        if err < best - step:
            return err, now
        if (now - since).to_sec() < STALL_S:
            return best, since
        # Not moving: under the base's deadband, so go faster, up to the top speed; stuck even there, it is blocked
        floor, top, name, unit = ((self.v_min, self.v_max, "v_min", "m/s") if speed == "v" else
                                  (self.w_min, self.w_max, "w_min", "rad/s"))
        if floor >= top:
            raise DockError(f"the base stopped {doing}, even at {top} {unit}: blocked?")
        setattr(self, name, min(top, floor * 1.5))
        rospy.logwarn("The base stopped %s: now at %.3f %s at least (_%s:=%.3f to start there)", doing,
                      getattr(self, name), unit, name, getattr(self, name))
        return best, now

    def turn(self, target, deadline):  # spin in place onto the goal heading
        best, since = math.inf, rospy.Time.now()
        while True:
            eth = self.error(target)[2]
            if abs(eth) < self.yaw_tol / 2:
                break
            best, since = self.progress(abs(eth), best, since, 0.005, "turning", deadline, "w")
            w = math.copysign(min(self.w_max, max(self.w_min, self.k_w * abs(eth))), eth)
            self.cmd.publish(Twist(angular=Vector3(z=w)))
            self.rate.sleep()
        self.stop()

    def crab(self, target, deadline):  # parallel mode straight onto the goal position, without turning
        best, since, forward = math.inf, rospy.Time.now(), None
        while True:
            ex, ey, _ = self.error(target)
            d = math.hypot(ex, ey)
            if d < self.xy_tol / 2:
                break
            best, since = self.progress(d, best, since, 0.003, "moving", deadline, "v")
            bearing = math.atan2(ey, ex)
            if forward is None:
                forward = abs(bearing) <= math.pi / 2
            elif abs(bearing) > math.pi / 2 + HYST or abs(bearing) < math.pi / 2 - HYST:
                forward = abs(bearing) < math.pi / 2  # in between, keep the wheels' side rather than flip them 180 deg
            steer = max(-math.pi / 2, min(math.pi / 2, bearing if forward else wrap(bearing - math.pi)))
            v = min(self.v_max, max(self.v_min, self.k_v * d)) * (1 if forward else -1)
            # The driver steers atan(vy / vx), drives the way vx points and only crabs while vy != 0: keep vx's sign
            # even at 90 deg (a -0.0 would turn it around) and vy off 0
            vx = math.copysign(max(abs(v * math.cos(steer)), 1e-6), v)
            vy = math.copysign(max(abs(v * math.sin(steer)), 1e-4), v * math.sin(steer))
            self.cmd.publish(Twist(linear=Vector3(x=vx, y=vy)))
            self.rate.sleep()
        self.stop()

    def stop(self, settle=True):
        for _ in range(3):
            self.cmd.publish(Twist())
        if settle:
            rospy.sleep(SETTLE_S)


def main():
    # Our own signal handling, so that Ctrl+C or a closed tmux window stops the base while ROS is still up
    rospy.init_node("aloha_dock", disable_signals=True)
    signal.signal(signal.SIGINT, signal.default_int_handler)  # even if started with Ctrl+C ignored, e.g. in background
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    signal.signal(signal.SIGHUP, lambda *_: sys.exit(0))
    dock = Dock()
    try:
        dock.run()
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        dock.stop(settle=False)
        rospy.signal_shutdown("stopped")


if __name__ == "__main__":
    main()
