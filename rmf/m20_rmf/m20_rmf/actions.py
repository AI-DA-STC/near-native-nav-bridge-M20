"""Performable actions: everything an M20 does inside an RMF task besides graph travel.

Each action is requested as a `perform_action` activity of an RMF compose task, e.g.

    {"category": "perform_action",
     "description": {"category": "explore", "description": {"zone": "new_area", "track": 0}}}

and runs on its own thread against the robot's M20Client. Off-graph motion is
announced to the RMF traffic schedule with override_schedule(), and by default the
robot walks back to where the action started (an RMF graph point) so RMF can resume
routing it afterwards.

| category        | description fields                                              |
|-----------------|-----------------------------------------------------------------|
| goto_pose       | pose [x,y,yaw] or place; check_yaw=false; return=false          |
| waypoints       | poses [[x,y,yaw] | place ...]; dwell=0; loops=1; return=true    |
| explore         | zone; track (index) or poses; dwell=<zone>; return=true         |
| inspect         | target; dwell=<target>; timeout=<target>                        |
| turn_to         | yaw | look_at [x,y] | target                                    |
| dwell           | seconds                                                         |
| stand_up        | settle=3                                                        |
| relocalize      | place | pose; settle=3; tolerance=0.5                           |
| signal          | event; data (any JSON)  -> /m20/events                          |
| wait_for_event  | event; timeout=600      <- /m20/trigger                         |

To add one: subclass Action, implement run(), register it in ACTIONS and add its name
to sitefile.ADAPTER_ACTIONS so the fleet config advertises it to RMF.
"""

import json
import math
import threading
import time
import uuid

import numpy as np
from geometry_msgs.msg import PoseWithCovarianceStamped

from .robot_client import NavState


class Cancelled(Exception):
    pass


class ActionFailed(Exception):
    pass


class Action:
    default_return = False

    def __init__(self, category, desc, execution, robot):
        self.category = category
        self.desc = desc
        self.execution = execution
        self.robot = robot
        self.client = robot.client
        self.site = robot.site
        self.bus = robot.bus
        self.done = False
        self._cancelled = threading.Event()
        self._stubborn = None
        self.start_pose = self.client.pose
        self.validate()

    # Override to reject bad requests before the robot moves.
    def validate(self):
        pass

    def run(self):
        raise NotImplementedError

    def describe(self):
        """What the GUI / RViz show for this action: kind, detail, remaining path."""
        return {'category': self.category, 'detail': '', 'path': []}

    # ------------------------------------------------------------ lifecycle
    def start(self):
        threading.Thread(target=self._main, daemon=True, name=f'{self.robot.id}-{self.category}').start()

    def _main(self):
        ok = True
        try:
            self.run()
        except Cancelled:
            ok = None
        except ActionFailed as e:
            ok = False
            self.bus.event(self.robot.id, f'action {self.category} failed: {e}')
            self.execution.error(f'{self.category}: {e}')
        except Exception as e:  # noqa: BLE001
            ok = False
            self.bus.event(self.robot.id, f'action {self.category} crashed: {e!r}')
            self.execution.error(f'{self.category}: {e!r}')
        finally:
            self._stubborn = None
            if ok is not None:
                # A failed action still finishes: RMF moves on to the next phase rather
                # than hanging the whole mission; the error is on the task log.
                self.execution.finished()
                if ok:
                    self.bus.event(self.robot.id, f'action {self.category} done')
            self.done = True

    def cancel(self, why=''):
        if not self._cancelled.is_set():
            self._cancelled.set()
            self.client.cancel()
            self.bus.event(self.robot.id, f'action {self.category} cancelled ({why})')

    @property
    def cancelled(self):
        return self._cancelled.is_set()

    # --------------------------------------------------------------- helpers
    def check(self):
        if self.cancelled:
            raise Cancelled()

    def sleep(self, seconds):
        if self._cancelled.wait(max(0.0, seconds)):
            raise Cancelled()

    def goto(self, pose, check_yaw=False, timeout=300.0):
        x, y, yaw = pose
        self.client.go_to(x, y, yaw, check_yaw=check_yaw)
        deadline = time.monotonic() + timeout
        while True:
            self.sleep(0.1)
            st = self.client.nav_state()
            if st == NavState.ARRIVED:
                return
            if st == NavState.FAILED:
                raise ActionFailed(f'could not reach ({x:.2f}, {y:.2f})')
            if time.monotonic() > deadline:
                self.client.cancel()
                raise ActionFailed(f'timeout reaching ({x:.2f}, {y:.2f})')

    def announce_path(self, poses):
        """Tell the RMF traffic schedule where this off-graph action will go."""
        pts = ([list(self.client.pose)] if self.client.pose else []) + [list(p) for p in poses]
        try:
            self._stubborn = self.execution.override_schedule(
                self.site.map_name, [np.array(p, dtype=float).reshape(3, 1) for p in pts], 0.0)
        except Exception as e:  # noqa: BLE001 - scheduling hint only; never block the action
            self.bus.event(self.robot.id, f'override_schedule failed: {e!r}')

    def underway(self, text):
        try:
            self.execution.underway(text)
        except Exception:  # noqa: BLE001
            pass

    def resolve(self, ref):
        return self.site.resolve_pose(ref)

    def maybe_return(self, exit_pose=None):
        if self.desc.get('return', self.default_return):
            target = exit_pose or self.start_pose
            if target is not None:
                self.underway('returning to graph')
                self.goto(target)


class GotoPose(Action):
    def validate(self):
        if 'pose' not in self.desc and 'place' not in self.desc:
            raise ValueError('needs pose or place')
        self.target = self.resolve(self.desc.get('pose', self.desc.get('place')))

    def describe(self):
        return {'category': self.category, 'detail': '', 'path': [list(self.target)]}

    def run(self):
        self.announce_path([self.target])
        self.underway(f'going to {self.target}')
        self.goto(self.target, check_yaw=bool(self.desc.get('check_yaw', False)))
        self.maybe_return()


class Waypoints(Action):
    default_return = True

    def poses(self):
        return [self.resolve(p) for p in self.desc.get('poses', [])]

    def dwell(self):
        return float(self.desc.get('dwell', 0.0))

    def exit_pose(self):
        return None

    _index = 0

    def describe(self):
        return {'category': self.category, 'detail': '',
                'path': [list(p) for p in self.path[self._index:]]}

    def validate(self):
        self.path = self.poses()
        if not self.path:
            raise ValueError('no poses')

    def run(self):
        loops = int(self.desc.get('loops', 1))
        self.announce_path(self.path * loops)
        for lap in range(loops):
            for i, p in enumerate(self.path):
                self._index = i
                self.underway(f'{self.category} {i + 1}/{len(self.path)} (lap {lap + 1}/{loops})')
                self.goto(p)
                self.bus.event(self.robot.id, f'{self.category} reached {i + 1}/{len(self.path)}',
                               pose=p)
                if self.dwell() > 0:
                    self.sleep(self.dwell())
        self.maybe_return(self.exit_pose())


class Explore(Waypoints):
    """Scripted exploration of a site zone: walk a track of off-graph poses."""

    def validate(self):
        zone_name = self.desc.get('zone')
        if zone_name not in self.site.zones:
            raise ValueError(f'unknown zone {zone_name!r}')
        self.zone = self.site.zones[zone_name]
        super().validate()

    def poses(self):
        if 'poses' in self.desc:
            return [self.resolve(p) for p in self.desc['poses']]
        tracks = self.zone['tracks']
        if tracks:
            return tracks[int(self.desc.get('track', 0)) % len(tracks)]
        return self.zone['poses']

    def dwell(self):
        return float(self.desc.get('dwell', self.zone['dwell']))

    def describe(self):
        d = super().describe()
        d['detail'] = self.desc.get('zone', '')
        return d

    def exit_pose(self):
        ex = self.zone.get('exit')
        return self.site.place(ex) if ex else None


class Inspect(Action):
    def validate(self):
        name = self.desc.get('target')
        if name not in self.site.targets:
            raise ValueError(f'unknown target {name!r}')
        self.name = name
        self.target = self.site.targets[name]
        self.awaiting_verdict = False

    def describe(self):
        path = [list(self.target['standoff'])] if self.target['standoff'] else []
        return {'category': self.category, 'detail': self.name, 'path': path,
                'awaiting_verdict': self.awaiting_verdict}

    def run(self):
        t = self.target
        if t['standoff'] is not None:
            self.announce_path([t['standoff']])
            self.underway(f'approaching {self.name}')
            self.goto(t['standoff'])
        if t['look_at'] is not None:
            face_towards(self, t['look_at'])
        req_id = f'{self.robot.id}-{self.name}-{uuid.uuid4().hex[:8]}'
        pose = self.client.pose
        self.bus.inspect_req.publish(_string({
            'id': req_id, 'robot': self.robot.id, 'target': self.name,
            'label': t['label'], 'pose': list(pose) if pose else None,
            'look_at': t['look_at'], 't': time.time()}))
        self.underway(f'inspecting {self.name} (request {req_id})')
        self.bus.event(self.robot.id, f'inspect request {req_id}', request_id=req_id,
                       target=self.name)
        dwell = float(self.desc.get('dwell', t['dwell']))
        timeout = float(self.desc.get('timeout', t['timeout']))
        started = time.monotonic()

        def match(channel, data):
            if channel != 'inspect':
                return False
            try:
                return json.loads(data).get('id') in (req_id, '*', 'latest')
            except ValueError:
                return False
        self.awaiting_verdict = True
        try:
            result = self.bus.wait_for(match, timeout, lambda: self.cancelled)
        finally:
            self.awaiting_verdict = False
        self.check()
        self.sleep(dwell - (time.monotonic() - started))
        self.bus.event(self.robot.id, f'inspect result for {self.name}: '
                       f'{result if result is not None else "TIMEOUT (no result)"}',
                       request_id=req_id, result=json.loads(result) if result else None)
        if t['standoff'] is not None:
            self.desc.setdefault('return', True)
        self.maybe_return()


def face_towards(action, xy):
    p = action.client.pose
    if p is None:
        return
    yaw = math.atan2(xy[1] - p[1], xy[0] - p[0])
    action.underway(f'turning to {math.degrees(yaw):.0f} deg')
    action.goto((p[0], p[1], yaw), check_yaw=True, timeout=60.0)


class TurnTo(Action):
    def validate(self):
        if not any(k in self.desc for k in ('yaw', 'look_at', 'target')):
            raise ValueError('needs yaw, look_at or target')

    def run(self):
        if 'yaw' in self.desc:
            p = self.client.pose
            self.goto((p[0], p[1], float(self.desc['yaw'])), check_yaw=True, timeout=60.0)
        elif 'look_at' in self.desc:
            face_towards(self, self.desc['look_at'])
        else:
            t = self.site.targets[self.desc['target']]
            face_towards(self, t['look_at'] or t['standoff'][:2])


class Dwell(Action):
    def run(self):
        s = float(self.desc.get('seconds', 5.0))
        self.underway(f'dwelling {s:.0f}s')
        self.sleep(s)


class StandUp(Action):
    def run(self):
        self.client.stand_up()
        self.sleep(float(self.desc.get('settle', 3.0)))


class Relocalize(Action):
    def validate(self):
        if 'place' not in self.desc and 'pose' not in self.desc:
            raise ValueError('needs place or pose')
        self.pose = self.resolve(self.desc.get('pose', self.desc.get('place')))

    def run(self):
        publish_initialpose(self.robot, self.pose)
        self.sleep(float(self.desc.get('settle', 3.0)))
        p = self.client.pose
        tol = float(self.desc.get('tolerance', 0.5))
        err = math.hypot(p[0] - self.pose[0], p[1] - self.pose[1]) if p else math.inf
        if err > tol:
            raise ActionFailed(f'pose is {err:.2f} m from the requested one after relocalizing')


def publish_initialpose(robot, pose, repeats=3):
    x, y, yaw = pose
    msg = PoseWithCovarianceStamped()
    msg.header.frame_id = 'map'
    msg.pose.pose.position.x = float(x)
    msg.pose.pose.position.y = float(y)
    msg.pose.pose.orientation.z = math.sin(yaw / 2.0)
    msg.pose.pose.orientation.w = math.cos(yaw / 2.0)
    cov = [0.0] * 36
    cov[0] = cov[7] = 0.25
    cov[35] = 0.07
    msg.pose.covariance = cov
    for _ in range(repeats):
        msg.header.stamp = robot.node.get_clock().now().to_msg()
        robot.initialpose_pub.publish(msg)
        time.sleep(0.3)
    robot.bus.event(robot.id, f'initialpose sent ({x:.2f}, {y:.2f}, {yaw:.2f})')


class Signal(Action):
    def run(self):
        self.bus.event(self.robot.id, f'signal {self.desc.get("event", "")}',
                       signal=self.desc.get('event'), data=self.desc.get('data'))


class WaitForEvent(Action):
    def run(self):
        want = self.desc.get('event', 'go')
        self.underway(f'waiting for trigger "{want}"')

        def match(channel, data):
            if channel != 'trigger':
                return False
            try:
                data = json.loads(data).get('event', data)
            except (ValueError, AttributeError):
                pass
            return data == want
        got = self.bus.wait_for(match, float(self.desc.get('timeout', 600.0)), lambda: self.cancelled)
        self.check()
        if got is None:
            self.bus.event(self.robot.id, f'wait_for_event "{want}" timed out')


ACTIONS = {
    'goto_pose': GotoPose,
    'waypoints': Waypoints,
    'explore': Explore,
    'inspect': Inspect,
    'turn_to': TurnTo,
    'dwell': Dwell,
    'stand_up': StandUp,
    'relocalize': Relocalize,
    'signal': Signal,
    'wait_for_event': WaitForEvent,
}


def make_action(category, desc, execution, robot):
    cls = ACTIONS.get(category)
    if cls is None:
        raise ValueError(f'unknown action {category!r}; known: {sorted(ACTIONS)}')
    if cls not in (Signal, WaitForEvent, Dwell, StandUp) and robot.client.pose is None:
        raise ValueError('robot has no pose')
    return cls(category, desc, execution, robot)


def _string(obj):
    from std_msgs.msg import String
    return String(data=json.dumps(obj))
