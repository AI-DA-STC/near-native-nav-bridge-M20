"""Stopping a mission: abort ends whatever the mission is waiting on, cancels the
robots' tasks, and leaves the mission in a final state (never stuck as running)."""

import json
import os
import threading
import time

from m20_rmf.mission import MissionRun, Runner
from m20_rmf.primitives import Fleet
from m20_rmf.rmf_client import Aborted, RmfClient
from m20_rmf.sitefile import Site

import pytest

SIM_SITE = os.path.join(os.path.dirname(__file__), '..', 'sites', 'sim_lab.yaml')


class _Pub:
    def __init__(self):
        self.sent = []

    def get_subscription_count(self):
        return 1

    def publish(self, msg):
        self.sent.append(msg.data)


class _FakeRmf:
    """Enough of RmfClient for the primitives; tasks never finish on their own."""
    wait = RmfClient.wait
    wait_trigger = RmfClient.wait_trigger
    pending_triggers = RmfClient.pending_triggers
    status = RmfClient.status
    active_tasks = RmfClient.active_tasks

    def __init__(self):
        self._lock = threading.Condition()
        self.tasks, self.triggers, self.robot_status = {}, [], {}
        self.mission_pub, self.stop_pub, self.mission_cmd_pub = _Pub(), _Pub(), _Pub()
        self.on_trigger = None
        self.cancelled = []
        self.n = 0

    def compose(self, robot, activities, category=''):
        self.n += 1
        tid = f't{self.n}'
        with self._lock:
            self.tasks[tid] = {'booking': {'id': tid, 'labels': [category]},
                               'status': 'underway', 'assigned_to': {'name': robot}}
        return tid

    def robot_task(self, robot, category, description, label=None):
        return self.compose(robot, [], label)

    def cancel(self, tid, timeout=None):
        self.cancelled.append(tid)
        with self._lock:
            self.tasks[tid]['status'] = 'canceled'
            self._lock.notify_all()

    def event(self, text, **kw):
        pass

    def states(self):
        return [json.loads(d).get('state') for d in self.mission_pub.sent]


def _fleet():
    return Fleet(Site.load(SIM_SITE), robots=['834'], client=_FakeRmf(),
                 log=lambda *_: None, console=False)


def _run(fleet, steps):
    return MissionRun(fleet, {'name': 't', 'steps': steps}, 't.yaml').start()


@pytest.mark.parametrize('steps', [
    [{'go_to': {'robot': '834', 'place': 'home_834'}}],                  # waiting on RMF
    [{'wait_trigger': {'event': 'suspicious'}}],                          # waiting on a signal
    [{'wait_trigger': {'prompt': 'Continue?'}}],                          # waiting on a button
    [{'sleep': 30}],
    [{'parallel': [{'sleep': 30}, {'go_to': {'robot': '834', 'place': 'home_834'}}]}],
])
def test_abort_ends_any_wait(steps):
    f = _fleet()
    run = _run(f, steps + [{'go_to': {'robot': '834', 'place': 'home_834'}}])
    time.sleep(0.3)
    assert not run.done.is_set()
    t0 = time.monotonic()
    run.abort('test')
    assert run.wait(2.0), 'mission still running after abort'
    assert time.monotonic() - t0 < 1.5
    assert f.mission['state'] == 'aborted' and f.mission['reason'] == 'test'
    # Nothing after the abort ran: at most the first go_to's task, and it was cancelled.
    assert f.rmf.n <= 1 and all(f.rmf.tasks[t]['status'] == 'canceled' for t in f.rmf.tasks)
    assert f.rmf.stop_pub.sent == ['834']          # the adapter was told to stop
    assert f.rmf.mission_cmd_pub.sent == []        # the mission's own stop: no self-abort


def test_complete_and_failed_are_final():
    f = _fleet()
    run = _run(f, [{'log': 'hi'}])
    assert run.wait(2.0) and f.mission['state'] == 'complete'
    f = _fleet()
    run = _run(f, [{'go_to': {'robot': '834', 'place': 'nowhere'}}])
    assert run.wait(2.0) and f.mission['state'] == 'failed'


def test_heartbeat_keeps_alive_fresh():
    f = _fleet()
    MissionRun.HEARTBEAT, old = 0.1, MissionRun.HEARTBEAT
    try:
        run = _run(f, [{'sleep': 30}])
        time.sleep(0.35)
        assert time.time() - f.mission['alive'] < 0.25
        run.abort('test')
        run.wait(2.0)
    finally:
        MissionRun.HEARTBEAT = old


def test_stop_ends_the_mission_and_a_stop_step_does_not():
    f = _fleet()
    f.stop(['834'])
    assert json.loads(f.rmf.mission_cmd_pub.sent[-1])['cmd'] == 'abort'
    f = _fleet()
    Runner(f, log=lambda *_: None).run_steps([{'stop': {'robots': ['834']}}])
    assert f.rmf.mission_cmd_pub.sent == []


def test_no_new_work_after_abort():
    f = _fleet()
    f.aborted.set()
    with pytest.raises(Aborted):
        f.go_to('834', 'home_834')
    assert f.rmf.n == 0
