"""Adapter actions against a fake robot: the explore time limit."""

import threading
import time

from m20_rmf.actions import make_action
from m20_rmf.robot_client import NavState
from m20_rmf.sitefile import Site

WALK = 0.3          # s the fake robot takes for any goal


class _Client:
    def __init__(self):
        self.pose = (0.0, 0.0, 0.0)
        self.goals, self.cancels = [], 0
        self._t = None

    def go_to(self, x, y, yaw, check_yaw=False):
        self.goals.append((x, y, yaw))
        self._t = time.monotonic()

    def nav_state(self):
        if self._t is None:
            return NavState.IDLE
        if time.monotonic() - self._t >= WALK:
            self.pose = self.goals[-1]
            return NavState.ARRIVED
        return NavState.NAVIGATING

    def cancel(self):
        self.cancels += 1
        self._t = None


class _Bus:
    def __init__(self):
        self.events = []

    def event(self, robot, text, **kw):
        self.events.append(text)


class _Execution:
    def __init__(self):
        self.finished_ = threading.Event()
        self.errors = []

    def finished(self):
        self.finished_.set()

    def error(self, text):
        self.errors.append(text)

    def underway(self, text):
        pass

    def override_schedule(self, *a):
        return None


class _Robot:
    def __init__(self, site):
        self.id, self.site = '834', site
        self.client, self.bus = _Client(), _Bus()


SITE = Site({'places': {'a': [0, 0, 0], 'b': [1, 0, 0], 'c': [1, 3, 1.57]},
             'lanes': [['a', 'b', 'c']],
             'zones': {'z': {'entry': 'b', 'boundary': [[2, -2], [9, -2], [9, 4], [2, 4]]},
                       'z2': {'entry': 'b', 'exit': 'c',
                              'boundary': [[2, -2], [9, -2], [9, 4], [2, 4]]}},
             'robots': {'834': {'ip': '127.0.0.1', 'home': 'a'}}})


def _explore(seconds, zone='z'):
    robot, ex = _Robot(SITE), _Execution()
    desc = {'zone': zone}
    if seconds:
        desc['seconds'] = seconds
    act = make_action('explore', desc, ex, robot)
    act.start()
    assert ex.finished_.wait(20), 'explore never finished'
    return robot, ex, act


def test_explore_time_limit_heads_back_and_finishes():
    robot, ex, act = _explore(seconds=0.75)       # time for ~2 of the sweep's poses
    poses = SITE.zones['z']['poses']
    assert len(poses) > 4
    visited = robot.client.goals[:-1]
    assert 1 <= len(visited) < len(poses)         # stopped part-way ...
    assert robot.client.cancels >= 1              # ... cancelling the goal in progress
    assert list(robot.client.goals[-1]) == [1.0, 0.0, 0.0]   # then to the exit = entry b
    assert ex.errors == []                        # a time limit is not a failure
    assert any('time up' in e for e in robot.bus.events)


def test_explore_without_limit_walks_everything():
    robot, ex, act = _explore(seconds=None)
    poses = SITE.zones['z']['poses']
    assert [list(g) for g in robot.client.goals[:len(poses)]] == poses
    assert ex.errors == [] and not any('time up' in e for e in robot.bus.events)


def test_explore_ends_at_its_exit_place():
    robot, ex, act = _explore(seconds=0.75, zone='z2')
    assert list(robot.client.goals[-1]) == [1.0, 3.0, 1.57]   # exit c, not the entry
    robot, ex, act = _explore(seconds=None, zone='z2')
    assert list(robot.client.goals[-1]) == [1.0, 3.0, 1.57]
