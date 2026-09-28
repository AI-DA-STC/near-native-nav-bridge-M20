"""Open-RMF EasyFullControl fleet adapter for DeepRobotics M20 quadrupeds.

    RMF core  --navigate/stop/action-->  M20Robot  --UDP :30000-->  robot
                                            ^
                     /ODOM_relayed_<id> ----+   (Foxy relay, shared map frame)

Navigation along the graph is RMF's (patrol, go_to_place, traffic negotiation).
Everything that leaves the graph or is not navigation is a *performable action*,
implemented in actions.py and advertised through the fleet config generated from
the site file. Add a new action there and to sitefile.ADAPTER_ACTIONS.

ROS interface (besides RMF's own topics):
  sub  /ODOM_relayed_<id>          nav_msgs/Odometry    robot pose
  pub  /m20/events                 std_msgs/String      JSON event log
  pub  /m20/robot_status           std_msgs/String      JSON per-robot status, 2 Hz
  sub  /m20/stop                   std_msgs/String      robot id or "all" -> cancel nav + task
  pub  /m20/inspect/request        std_msgs/String      JSON, from the inspect action
  sub  /m20/inspect/result         std_msgs/String      JSON {"id": ..., ...}
  sub  /m20/trigger                std_msgs/String      event name, for wait_for_event
  pub  /initialpose_set_relayed_<id>  PoseWithCovarianceStamped  relocalize action
"""

import argparse
import json
import math
import os
import sys
import tempfile
import threading
import time

import rclpy
import rclpy.node
from rclpy.executors import MultiThreadedExecutor
from rclpy.qos import QoSProfile, ReliabilityPolicy, HistoryPolicy
from geometry_msgs.msg import PoseWithCovarianceStamped
from nav_msgs.msg import Odometry
from std_msgs.msg import String

import rmf_adapter
from rmf_adapter import Adapter
import rmf_adapter.easy_full_control as rmf_easy

from . import domain_guard
from .actions import make_action
from .robot_client import M20Client, NavState
from .sitefile import Site


def yaw_from_quat(q):
    return math.atan2(2.0 * (q.w * q.z + q.x * q.y), 1.0 - 2.0 * (q.y * q.y + q.z * q.z))


class M20Robot:
    """Bridges one robot between RMF callbacks and its M20Client."""

    def __init__(self, rid, cfg, site, node, fleet_handle, robot_config, bus):
        self.id = rid
        self.site = site
        self.node = node
        self.fleet_handle = fleet_handle
        self.robot_config = robot_config
        self.bus = bus
        self.update_handle = None
        self.execution = None      # CommandExecution for a graph navigation
        self.action = None         # running actions.Action
        self.lock = threading.RLock()
        self.client = M20Client(
            rid, cfg['ip'], int(cfg.get('port', 30000)),
            xy_tolerance=float(cfg.get('xy_tolerance', 0.15)),
            stall_timeout=float(cfg.get('stall_timeout', 25.0)),
            nav_params=cfg.get('nav') or {},
            on_event=lambda name, text: bus.event(name, text))
        qos = QoSProfile(history=HistoryPolicy.KEEP_LAST, depth=5,
                         reliability=ReliabilityPolicy.BEST_EFFORT)
        self.odom_topic = f'/ODOM_relayed_{rid}'
        node.create_subscription(Odometry, self.odom_topic, self._odom_cb, qos)
        self.initialpose_pub = node.create_publisher(
            PoseWithCovarianceStamped, f'/initialpose_set_relayed_{rid}', 10)
        self._warned_no_pose = 0.0

    # ------------------------------------------------------------ callbacks
    def _odom_cb(self, msg):
        p = msg.pose.pose
        self.client.update_pose(p.position.x, p.position.y, yaw_from_quat(p.orientation))

    def make_callbacks(self):
        return rmf_easy.RobotCallbacks(
            lambda dest, execution: self.navigate(dest, execution),
            lambda activity: self.stop(activity),
            lambda category, desc, execution: self.execute_action(category, desc, execution))

    def navigate(self, destination, execution):
        if self.client.asleep:
            self.bus.event(self.id, 'WARNING: robot reports Sleep=1; it will not walk '
                           'until stood up (controller, or the stand_up action)')
        with self.lock:
            self._abort_action('superseded by navigation')
            self.execution = execution
            x, y, yaw = (float(v) for v in destination.position)
            name = destination.name or f'({x:.2f}, {y:.2f})'
            self.bus.event(self.id, f'RMF navigate -> {name}')
            self.client.go_to(x, y, yaw)

    def stop(self, activity):
        with self.lock:
            if self.execution is not None and self.execution.identifier.is_same(activity):
                self.execution = None
                self.client.cancel()
                self.bus.event(self.id, 'RMF stop (navigation)')
            elif self.action is not None and self.action.execution.identifier.is_same(activity):
                self._abort_action('RMF stop')

    def execute_action(self, category, description, execution):
        with self.lock:
            self._abort_action('superseded by new action')
            self.execution = None
            try:
                self.action = make_action(category, description or {}, execution, self)
            except Exception as e:  # noqa: BLE001 - reported to RMF and the operator
                self.bus.event(self.id, f'action {category} rejected: {e}')
                execution.error(f'{category}: {e}')
                execution.finished()
                return
            self.bus.event(self.id, f'action {category} start {json.dumps(description)}')
            self.action.start()

    def _abort_action(self, why):
        if self.action is not None:
            if not self.action.done:
                self.action.cancel(why)
            self.action = None

    # --------------------------------------------------------------- update
    def update(self):
        pose = self.client.pose
        if pose is None:
            now = time.monotonic()
            if now - self._warned_no_pose > 10.0:
                self._warned_no_pose = now
                self.node.get_logger().warn(
                    f'[{self.id}] no pose yet: nothing on {self.odom_topic} and no UDP '
                    f'LocationStatus from {self.client.addr[0]} (udp link '
                    f'{"up" if self.client.link_ok else "DOWN"})')
            return
        battery = self.client.battery if self.client.battery is not None else 1.0
        state = rmf_easy.RobotState(self.site.map_name, list(pose), battery)
        if self.update_handle is None:
            now = time.monotonic()
            if now - getattr(self, '_last_add_attempt', -1e9) < 5.0:
                return
            self._last_add_attempt = now
            self.update_handle = self.fleet_handle.add_robot(
                self.id, state, self.robot_config, self.make_callbacks())
            if self.update_handle is None:
                near = self.site.nearest_place(pose[0], pose[1])
                d = math.hypot(pose[0] - self.site.places[near][0],
                               pose[1] - self.site.places[near][1])
                self.bus.event(self.id, f'RMF refused to add robot at ({pose[0]:.2f}, '
                               f'{pose[1]:.2f}); nearest place {near} is {d:.1f} m away. Robots '
                               'must start on or near the nav graph (or relocalize). Retrying '
                               'every 5 s.')
                return
            f = self.site.fleet
            self.update_handle.set_max_merge_waypoint_distance(
                float(f.get('merge_waypoint_distance', 0.5)))
            self.update_handle.set_max_merge_lane_distance(
                float(f.get('merge_lane_distance', 1.0)))
            self.bus.event(self.id, f'registered with RMF at ({pose[0]:.2f}, {pose[1]:.2f})')
            return

        activity = None
        with self.lock:
            if self.execution is not None:
                st = self.client.nav_state()
                if st == NavState.ARRIVED:
                    self.execution.finished()
                    self.execution = None
                elif st == NavState.FAILED:
                    self.bus.event(self.id, 'navigation failed; asking RMF to replan')
                    self.execution = None
                    self.update_handle.more().replan()
                else:
                    activity = self.execution.identifier
            elif self.action is not None:
                if self.action.done:
                    self.action = None
                else:
                    activity = self.action.execution.identifier
        self.update_handle.update(state, activity)

    def status(self):
        pose = self.client.pose
        with self.lock:
            if self.action is not None:
                activity = f'action:{self.action.category}'
            elif self.execution is not None:
                activity = 'navigate'
            else:
                activity = 'idle'
        return {
            'robot': self.id,
            'pose': [round(v, 3) for v in pose] if pose else None,
            'pose_age': round(self.client.pose_age(), 2) if pose else None,
            'udp_link': self.client.link_ok,
            'pose_source': self.client.pose_source,
            'localized': self.client.localized,
            'asleep': self.client.asleep,
            'battery': self.client.battery,
            'height': self.client.motion.get('Height'),
            'robot_errors': self.client.errors,
            'registered': self.update_handle is not None,
            'activity': activity,
            'goal_distance': self.client.goal_distance(),
        }


class Bus:
    """Shared ROS pub/sub for events, inspection, triggers and e-stop."""

    def __init__(self, node):
        self.node = node
        self.events = node.create_publisher(String, '/m20/events', 50)
        self.status = node.create_publisher(String, '/m20/robot_status', 10)
        self.inspect_req = node.create_publisher(String, '/m20/inspect/request', 10)
        self._waiters = []   # (predicate, threading.Event, holder)
        self._wlock = threading.Lock()
        node.create_subscription(String, '/m20/inspect/result', self._on_msg('inspect'), 10)
        node.create_subscription(String, '/m20/trigger', self._on_msg('trigger'), 10)

    def event(self, robot, text, **extra):
        self.node.get_logger().info(f'[{robot}] {text}')
        self.events.publish(String(data=json.dumps(
            {'robot': robot, 'text': text, 't': time.time(), **extra})))

    def _on_msg(self, channel):
        def cb(msg):
            with self._wlock:
                for pred, ev, holder in list(self._waiters):
                    if pred(channel, msg.data):
                        holder.append(msg.data)
                        ev.set()
        return cb

    def wait_for(self, predicate, timeout, cancelled):
        """Block until predicate(channel, data) is true, timeout, or cancelled()."""
        ev, holder = threading.Event(), []
        entry = (predicate, ev, holder)
        with self._wlock:
            self._waiters.append(entry)
        try:
            deadline = time.monotonic() + timeout
            while not ev.wait(0.2):
                if cancelled() or time.monotonic() > deadline:
                    return None
            return holder[0]
        finally:
            with self._wlock:
                self._waiters.remove(entry)


def main(argv=sys.argv):
    domain_guard.check(argv=argv)
    rclpy.init(args=argv)
    rmf_adapter.init_rclcpp()
    args_ = rclpy.utilities.remove_ros_args(argv)
    parser = argparse.ArgumentParser(prog='m20_fleet_adapter')
    parser.add_argument('-s', '--site', required=True, help='site YAML')
    parser.add_argument('--robots', default='', help='comma list; default: all in site')
    parser.add_argument('--server-uri', default='ws://localhost:7878',
                        help='task-state websocket (m20_rmf monitor); "" to disable')
    parser.add_argument('--out-dir', default=os.path.join(tempfile.gettempdir(), 'm20_rmf'))
    args = parser.parse_args(args_[1:])

    site = Site.load(args.site)
    for w in site.warnings():
        print(f'[site warning] {w}', file=sys.stderr)
    wanted = [r for r in args.robots.split(',') if r] or site.robot_ids()
    unknown = set(wanted) - set(site.robots)
    if unknown:
        sys.exit(f'robots not in site: {sorted(unknown)}')
    site.robots = {k: v for k, v in site.robots.items() if k in wanted}

    os.makedirs(args.out_dir, exist_ok=True)
    nav_path = os.path.join(args.out_dir, 'nav_graph.yaml')
    cfg_path = os.path.join(args.out_dir, 'fleet_config.yaml')
    site.write(nav_path, cfg_path)
    fleet_config = rmf_easy.FleetConfiguration.from_config_files(cfg_path, nav_path)
    if fleet_config is None:
        sys.exit(f'RMF rejected generated config {cfg_path}')
    fleet_config.server_uri = args.server_uri or None

    node = rclpy.node.Node(f'{fleet_config.fleet_name}_m20_adapter')
    adapter = Adapter.make(f'{fleet_config.fleet_name}_fleet_adapter')
    if adapter is None:
        sys.exit('Could not start RMF adapter — is rmf_traffic_schedule running?')
    adapter.start()
    time.sleep(1.0)
    fleet_handle = adapter.add_easy_fleet(fleet_config)

    bus = Bus(node)
    robots = {
        rid: M20Robot(rid, site.robots[rid], site, node, fleet_handle,
                      fleet_config.get_known_robot_configuration(rid), bus)
        for rid in wanted
    }

    # Safe stop (robot keeps standing): cancel the robot's navigation over UDP, drop any
    # running action, and cancel its current RMF task so RMF does not re-send a goal.
    # The vendor e-stop (which drops the robot) is deliberately not reachable from ROS.
    def on_stop(msg):
        target = msg.data.strip()
        for rid, r in robots.items():
            if target not in ('all', '', rid):
                continue
            with r.lock:
                r._abort_action('operator stop')
                r.execution = None
            r.client.cancel()
            if r.update_handle is not None:
                tid = r.update_handle.more().current_task_id()
                if tid:
                    r.update_handle.more().cancel_task(tid, ['m20 stop'], lambda ok: None)
            bus.event(rid, 'STOP requested: navigation cancelled, current task cancelled')
    node.create_subscription(String, '/m20/stop', on_stop, 10)

    def update_loop():
        while rclpy.ok():
            t0 = time.monotonic()
            for r in robots.values():
                try:
                    r.update()
                except Exception as e:  # noqa: BLE001 - one robot must not stall the rest
                    node.get_logger().error(f'[{r.id}] update error: {e!r}')
            time.sleep(max(0.0, 0.1 - (time.monotonic() - t0)))

    def status_loop():
        while rclpy.ok():
            bus.status.publish(String(data=json.dumps([r.status() for r in robots.values()])))
            time.sleep(0.5)

    threading.Thread(target=update_loop, daemon=True).start()
    threading.Thread(target=status_loop, daemon=True).start()
    node.get_logger().info(
        f'M20 fleet adapter up: robots {wanted}, site {args.site}, graph {nav_path}')

    executor = MultiThreadedExecutor()
    executor.add_node(node)
    try:
        executor.spin()
    except KeyboardInterrupt:
        pass
    finally:
        for r in robots.values():
            r.client.close()
        rclpy.try_shutdown()


if __name__ == '__main__':
    main()
