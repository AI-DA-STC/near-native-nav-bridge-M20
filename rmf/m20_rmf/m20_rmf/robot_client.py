"""One M20 over UDP: heartbeat, goal tracking, arrival and stall detection.

Pure Python (no ROS), so it can be unit-tested against mock_robot and reused by any
front end.

Pose has two sources, both in the shared SLAM map frame:
  * update_pose(), fed by the adapter from /ODOM_relayed_<id> (10 Hz, needs the relay)
  * the robot's own UDP status stream, Type 1002/7 LocationStatus (~1 Hz, always on
    while we send heartbeats)
Odometry wins while it is fresh; the UDP pose takes over when it goes stale, so the
fleet keeps working (more coarsely) if the relay is down. The same stream carries
battery (1002/5), sleep/motion state (1002/6) and nav status (1002/7).
"""

import logging
import math
import socket
import threading
import time

from . import protocol

log = logging.getLogger('m20_rmf.robot_client')


class Goal:
    def __init__(self, value, x, y, yaw, params, check_yaw):
        self.value = value
        self.x, self.y, self.yaw = x, y, yaw
        self.params = params
        self.check_yaw = check_yaw
        self.sent_at = time.monotonic()
        self.best_dist = math.inf
        self.last_progress = self.sent_at
        self.resends = 0
        self.robot_complete = False
        self.error = None


class NavState:
    IDLE = 'idle'
    NAVIGATING = 'navigating'
    ARRIVED = 'arrived'
    FAILED = 'failed'


def wrap(a):
    return math.atan2(math.sin(a), math.cos(a))


class M20Client:
    def __init__(self, name, ip, port=protocol.PORT, xy_tolerance=0.15,
                 yaw_tolerance=0.35, stall_timeout=25.0, max_resends=3,
                 heartbeat_period=1.0, nav_params=None, on_event=None, settle_time=0.6):
        self.name = name
        self.addr = (ip, port)
        self.xy_tolerance = xy_tolerance
        self.yaw_tolerance = yaw_tolerance
        self.stall_timeout = stall_timeout
        self.max_resends = max_resends
        self.settle_time = settle_time
        self.nav_params = dict(nav_params or {})
        self.on_event = on_event or (lambda name, text: None)

        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.bind(('0.0.0.0', 0))
        self._sock.settimeout(0.5)
        self._lock = threading.RLock()
        self._msg_id = 0
        self._value = 0
        self._goal = None
        self._legs = []            # remaining legs of the current move
        self._state = NavState.IDLE
        self._pose = None          # (x, y, yaw)
        self._pose_stamp = 0.0
        self._anchor = None        # pose where the robot was last seen to move from
        self._last_move = 0.0
        self.last_response = None
        self.last_rx = 0.0
        self._stop = threading.Event()
        self._odom_stamp = 0.0
        self.pose_source = None     # 'odom' | 'udp'
        self.battery = None         # 0..1, mean of the packs
        self.basic = {}             # BasicStatus: Sleep, MotionState, Gait, Charge, ...
        self.localized = None       # LocationStatus.Location == 1
        self.motion = {}            # MotionStatus: Height, LinearX, ...
        self.errors = []            # ErrorList

        self._threads = [
            threading.Thread(target=self._heartbeat_loop, args=(heartbeat_period,), daemon=True),
            threading.Thread(target=self._rx_loop, daemon=True),
        ]
        for t in self._threads:
            t.start()

    # ------------------------------------------------------------------ pose
    def update_pose(self, x, y, yaw, source='odom'):
        now = time.monotonic()
        with self._lock:
            if source == 'odom':
                self._odom_stamp = now
            elif now - self._odom_stamp < 1.0:
                return          # odometry is fresh; ignore the coarser UDP pose
            self.pose_source = source
            self._pose = (x, y, yaw)
            self._pose_stamp = now
            a = self._anchor
            if a is None or math.hypot(x - a[0], y - a[1]) > 0.03 or abs(wrap(yaw - a[2])) > 0.05:
                self._anchor = (x, y, yaw)
                self._last_move = now

    def settled(self):
        """True once the robot has not moved for settle_time seconds."""
        with self._lock:
            return time.monotonic() - self._last_move >= self.settle_time

    @property
    def pose(self):
        with self._lock:
            return self._pose

    def pose_age(self):
        with self._lock:
            return math.inf if self._pose is None else time.monotonic() - self._pose_stamp

    # -------------------------------------------------------------- commands
    def send(self, payload):
        with self._lock:
            packet = protocol.encode(payload, self._msg_id)
            self._msg_id = (self._msg_id + 1) & 0xFFFF
        self._sock.sendto(packet, self.addr)

    # The M20 turns towards a goal's heading *while* it walks: a goal whose heading
    # differs from the direction of travel, or a start facing away from it, makes it walk
    # backwards or strafe (seen on 834, 2026-09-28). With face_travel (default on;
    # per-robot `nav: {face_travel: false}` to disable) a move becomes up to three legs:
    # turn in place to face the travel direction, walk straight there, turn in place to
    # the requested heading.
    FACE_TRAVEL_MIN_DIST = 0.4                  # m; shorter moves go as one goal
    FACE_TRAVEL_MIN_ANGLE = math.radians(30)    # heading mismatch that adds a turn

    def go_to(self, x, y, yaw, check_yaw=False, **overrides):
        """Send a navigation goal and start tracking it. Replaces any active goal."""
        params = {**self.nav_params, **overrides}
        with self._lock:
            if self._goal is not None and self._state == NavState.NAVIGATING:
                # The robot rejects a new goal while one runs (0xA341).
                self.send(protocol.cancel_nav())
                time.sleep(0.3)
            legs = self._plan_legs(x, y, yaw, check_yaw, params)
            self._legs = legs[1:]
            self._start_leg(*legs[0], params)
        plan = ' -> '.join(self._describe(leg) for leg in legs)
        self.on_event(self.name, f'goal #{self._value}: {plan}')

    def _plan_legs(self, x, y, yaw, check_yaw, params):
        """[(x, y, yaw, check_yaw), ...] for one move; see FACE_TRAVEL_* above."""
        p = self._pose
        if not params.get('face_travel', True) or p is None:
            return [(x, y, yaw, check_yaw)]
        dist = math.hypot(x - p[0], y - p[1])
        if dist <= self.FACE_TRAVEL_MIN_DIST:
            return [(x, y, yaw, check_yaw)]
        travel = math.atan2(y - p[1], x - p[0])
        legs = []
        if abs(wrap(p[2] - travel)) > self.FACE_TRAVEL_MIN_ANGLE:
            legs.append((p[0], p[1], travel, True))          # turn to face the way
        legs.append((x, y, travel, False))                    # walk straight
        if abs(wrap(yaw - travel)) > self.FACE_TRAVEL_MIN_ANGLE:
            legs.append((x, y, yaw, True))                    # turn to the final heading
        elif check_yaw:
            legs[-1] = (x, y, yaw, True)
        return legs

    @staticmethod
    def _describe(leg):
        x, y, yaw, check_yaw = leg
        return f'({x:.2f}, {y:.2f}, {yaw:.2f}{" turn" if check_yaw else ""})'

    def _start_leg(self, x, y, yaw, check_yaw, params):
        """Make (x, y, yaw) the active goal and send it (caller holds the lock)."""
        self._value += 1
        self._goal = Goal(self._value, x, y, yaw, params, check_yaw)
        if self._pose is not None:
            # Baseline for stall detection: progress is measured from here.
            self._goal.best_dist = math.hypot(self._pose[0] - x, self._pose[1] - y)
        self._state = NavState.NAVIGATING
        # Non-blocking: callers are RMF callbacks and the mission runner.
        threading.Thread(target=self._send_goal, daemon=True).start()

    def _send_goal(self):
        g = self._goal
        if g is None:
            return
        self.send(protocol.heartbeat())
        self.send(protocol.nav_mode())
        # The C++ bridge waits 1 s after the mode switch; the robot drops goals sent
        # immediately after it.
        time.sleep(1.0)
        if self._goal is not g:
            return  # superseded while waiting
        self.send(protocol.nav_goal(
            g.value, g.x, g.y, g.yaw,
            gait=g.params.get('gait'), speed=g.params.get('speed'),
            manner=g.params.get('manner'), obs_mode=g.params.get('obs_mode'),
            nav_mode_=g.params.get('nav_mode')))

    def cancel(self):
        with self._lock:
            self._legs = []
            self._goal = None
            self._state = NavState.IDLE
        self.send(protocol.cancel_nav())
        self.on_event(self.name, 'cancel')

    def stand_up(self):
        self.send(protocol.stand_up())

    def estop(self):
        with self._lock:
            self._legs = []
            self._goal = None
            self._state = NavState.IDLE
        self.send(protocol.estop())
        self.on_event(self.name, 'ESTOP')

    # ---------------------------------------------------------------- status
    def nav_state(self):
        """Poll-driven state machine; call periodically (the adapter does at 10 Hz)."""
        with self._lock:
            g, pose = self._goal, self._pose
            if g is None or self._state != NavState.NAVIGATING:
                return self._state
            if g.error is not None and g.error in protocol.FATAL_ERRORS:
                self._state = NavState.FAILED
                return self._state
            if pose is None:
                return self._state
            dist = math.hypot(pose[0] - g.x, pose[1] - g.y)
            yaw_ok = (not g.check_yaw) or abs(wrap(pose[2] - g.yaw)) <= self.yaw_tolerance
            # Within tolerance is not enough: the dog may still be walking in, and a
            # new goal while its own is active is rejected (0xA341). Wait until it
            # has stopped, unless it already told us it is done.
            in_tol = dist <= self.xy_tolerance and yaw_ok
            if (in_tol and (g.robot_complete or self.settled())) or \
                    (g.robot_complete and dist <= 3 * self.xy_tolerance):
                if self._legs:
                    # Next leg of the same move (turn / walk / turn).
                    leg = self._legs.pop(0)
                    self.on_event(self.name, f'goal #{g.value} done, next leg {self._describe(leg)}')
                    self._start_leg(*leg, g.params)
                    return NavState.NAVIGATING
                self._state = NavState.ARRIVED
                self.on_event(self.name, f'arrived at goal #{g.value} (err {dist:.2f} m)')
                return self._state
            now = time.monotonic()
            if dist < g.best_dist - 0.05:
                g.best_dist = dist
                g.last_progress = now
            stalled = now - g.last_progress > self.stall_timeout
            resend = stalled or g.error == 0xA341
        if resend:
            busy = g.error == 0xA341
            if g.resends >= self.max_resends:
                with self._lock:
                    self._state = NavState.FAILED
                self.on_event(self.name, f'goal #{g.value} failed after {g.resends} resends')
                return NavState.FAILED
            g.resends += 1
            g.last_progress = time.monotonic()
            g.error = None
            why = 'robot busy (0xA341)' if busy else 'no progress'
            self.on_event(self.name, f'goal #{g.value} {why}, resend {g.resends}')

            def resend_goal():
                if g.resends > 1 or busy:
                    self.send(protocol.cancel_nav())
                    time.sleep(0.3)
                if self._goal is g:
                    self._send_goal()
            # _send_goal sleeps ~1 s for the mode switch; keep the caller's loop live.
            threading.Thread(target=resend_goal, daemon=True).start()
        return NavState.NAVIGATING

    def goal_distance(self):
        with self._lock:
            if self._goal is None or self._pose is None:
                return None
            return math.hypot(self._pose[0] - self._goal.x, self._pose[1] - self._goal.y)

    @property
    def goal(self):
        return self._goal

    @property
    def link_ok(self):
        """True if the robot answered any packet in the last 5 s."""
        return time.monotonic() - self.last_rx < 5.0

    # --------------------------------------------------------------- threads
    def _heartbeat_loop(self, period):
        while not self._stop.wait(period):
            try:
                self.send(protocol.heartbeat())
            except OSError as e:
                log.warning('%s heartbeat failed: %s', self.name, e)

    def _rx_loop(self):
        while not self._stop.is_set():
            try:
                data, _ = self._sock.recvfrom(8192)
            except socket.timeout:
                continue
            except OSError:
                break
            try:
                payload = protocol.decode(data)
                if payload is None:
                    continue
                r = protocol.Response(payload)
            except Exception as e:  # noqa: BLE001 - never let a bad packet kill rx
                log.warning('%s: unparseable reply %r: %s', self.name, data[:64], e)
                continue
            self.last_rx = time.monotonic()
            self.last_response = r
            kind = r.status_kind
            if kind is not None:
                self._on_status(kind, r)
                continue
            if not (r.is_nav_ack or r.is_nav_status):
                continue
            with self._lock:
                g = self._goal
                if g is None:
                    continue
                if r.error not in (None, 0, 0x2302):
                    g.error = r.error
                if r.is_nav_status and r.status == protocol.STATUS_COMPLETE and \
                        (r.value is None or r.value == g.value):
                    g.robot_complete = True
            self.on_event(self.name, r.describe())

    def _on_status(self, kind, r):
        it = r.items
        if kind == 'location':
            loc = it.get('LocationStatus') or {}
            if 'PosX' in loc:
                self.localized = loc.get('Location') == 1
                self.update_pose(float(loc['PosX']), float(loc['PosY']), float(loc.get('Yaw', 0.0)),
                                 source='udp')
            nav = it.get('NavStatus') or {}
            with self._lock:
                g = self._goal
                if g is not None and nav.get('Value') == g.value:
                    if nav.get('Status') == protocol.STATUS_COMPLETE:
                        g.robot_complete = True
                    err = protocol._int(nav.get('ErrorCode'))
                    if err not in (None, 0, 0x2302):
                        g.error = err
        elif kind == 'battery':
            levels = [b.get('BatteryLevel') for b in it.get('BatteryList') or []
                      if isinstance(b.get('BatteryLevel'), (int, float))]
            if levels:
                self.battery = sum(levels) / len(levels) / 100.0
        elif kind == 'basic':
            self.basic = it.get('BasicStatus') or {}
        elif kind == 'motion':
            self.motion = it.get('MotionStatus') or {}
        elif kind == 'errors':
            errs = it.get('ErrorList') or []
            if errs != self.errors and errs:
                self.on_event(self.name, f'robot errors: {errs}')
            self.errors = errs

    @property
    def asleep(self):
        return bool(self.basic.get('Sleep')) if self.basic else None

    def close(self):
        self._stop.set()
        self._sock.close()
