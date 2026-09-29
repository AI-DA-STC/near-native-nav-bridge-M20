"""Thin client for the Open-RMF task API (ROS side), with task tracking.

Requests go out as rmf_task_msgs/ApiRequest JSON on /task_api_requests — the same
path rmf_demos_tasks' dispatch_* scripts and rmf-web use — and responses come back on
/task_api_responses. Progress comes from /m20/task_states (see monitor.py).

Owns its own rclpy node spun on a background thread, so it can be used from plain
scripts, the mission runner and the CLI alike.
"""

import json
import threading
import time
import uuid

import rclpy
import rclpy.node
from rclpy.executors import SingleThreadedExecutor
from rclpy.qos import QoSProfile, DurabilityPolicy, HistoryPolicy, ReliabilityPolicy
from rmf_task_msgs.msg import ApiRequest, ApiResponse
from std_msgs.msg import String

TERMINAL = {'completed', 'failed', 'canceled', 'killed', 'skipped'}


def parse_trigger(data):
    """'/m20/trigger' payload -> {'event': name, ...}; plain strings are the event name."""
    try:
        d = json.loads(data)
        if isinstance(d, dict) and 'event' in d:
            return d
    except ValueError:
        pass
    return {'event': str(data).strip()}


class TaskError(RuntimeError):
    pass


class Aborted(Exception):
    """The mission was aborted (operator stop, Ctrl-C, GUI)."""


class RmfClient:
    def __init__(self, fleet='m20', node_name=None):
        if not rclpy.ok():
            # No rclpy signal handlers: its Ctrl-C/SIGTERM handler shuts ROS down before
            # our code runs, so an aborting mission could no longer cancel tasks or say
            # it aborted (the GUI then showed it running forever). Ctrl-C stays a plain
            # KeyboardInterrupt and cleanup still has ROS.
            from rclpy.signals import SignalHandlerOptions
            rclpy.init(signal_handler_options=SignalHandlerOptions.NO)
        self.fleet = fleet
        self._born = time.monotonic()
        self.node = rclpy.node.Node(node_name or f'm20_client_{uuid.uuid4().hex[:6]}')
        latched = QoSProfile(history=HistoryPolicy.KEEP_LAST, depth=10,
                             reliability=ReliabilityPolicy.RELIABLE,
                             durability=DurabilityPolicy.TRANSIENT_LOCAL)
        self._req_pub = self.node.create_publisher(ApiRequest, '/task_api_requests', latched)
        self.node.create_subscription(ApiResponse, '/task_api_responses', self._on_response, latched)
        self.node.create_subscription(
            String, '/m20/task_states', self._on_task_state,
            QoSProfile(depth=100, reliability=ReliabilityPolicy.RELIABLE,
                       durability=DurabilityPolicy.TRANSIENT_LOCAL))
        self.node.create_subscription(String, '/m20/robot_status', self._on_robot_status, 10)
        self.stop_pub = self.node.create_publisher(String, '/m20/stop', 10)
        self.trigger_pub = self.node.create_publisher(String, '/m20/trigger', 10)
        # Operator signals are buffered, so one sent before the mission reaches its
        # wait_trigger (e.g. "suspicious item" pressed early) is not lost.
        self.triggers = []          # [(monotonic time, {'event': name, ...payload})]
        self.on_trigger = None      # callback after a signal arrives (mission state)
        self.node.create_subscription(String, '/m20/trigger', self._on_trigger, 10)
        # Mission state for the status hub / GUI: latched, last value only.
        self.mission_pub = self.node.create_publisher(
            String, '/m20/mission',
            QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE,
                       durability=DurabilityPolicy.TRANSIENT_LOCAL))
        # Mission control: {"cmd": "start", "file": ...} for the mission host,
        # {"cmd": "abort", "reason": ...} for whatever mission is running (host or
        # `m20 mission`). Every STOP sends an abort: a stop always ends the mission.
        self.mission_cmd_pub = self.node.create_publisher(String, '/m20/mission_cmd', 10)
        self.on_mission_cmd = None  # callback(dict), called on the spin thread: don't block
        self.node.create_subscription(String, '/m20/mission_cmd', self._on_mission_cmd, 10)
        self.events_pub = self.node.create_publisher(String, '/m20/events', 50)
        self.inspect_result_pub = self.node.create_publisher(String, '/m20/inspect/result', 10)

        self._lock = threading.Condition()
        self._responses = {}
        self.tasks = {}           # task_id -> latest state dict
        self.robot_status = {}    # robot -> status dict
        self._exec = SingleThreadedExecutor()
        self._exec.add_node(self.node)
        self._running = True
        self._thread = threading.Thread(target=self._spin, daemon=True)
        self._thread.start()

    def _spin(self):
        while self._running and rclpy.ok():
            self._exec.spin_once(timeout_sec=0.1)

    # -------------------------------------------------------------- inbound
    def _on_response(self, msg):
        with self._lock:
            self._responses[msg.request_id] = json.loads(msg.json_msg)
            self._lock.notify_all()

    def _on_task_state(self, msg):
        data = json.loads(msg.data)
        tid = (data.get('booking') or {}).get('id')
        if tid:
            with self._lock:
                self.tasks[tid] = data
                self._lock.notify_all()

    SAME_SIGNAL = 1.0       # s: an identical signal again within this is a double-click

    def _on_trigger(self, msg):
        now, payload = time.monotonic(), parse_trigger(msg.data)
        with self._lock:
            if any(p == payload and now - t < self.SAME_SIGNAL for t, p in self.triggers[-5:]):
                return
            self.triggers.append((now, payload))
            del self.triggers[:-50]
            self._lock.notify_all()
        if self.on_trigger:
            self.on_trigger()

    def _on_mission_cmd(self, msg):
        try:
            cmd = json.loads(msg.data)
        except ValueError:
            cmd = {'cmd': msg.data.strip()}
        if self.on_mission_cmd and isinstance(cmd, dict):
            self.on_mission_cmd(cmd)

    def pending_triggers(self, since):
        """Events received after `since` and not yet consumed by a wait."""
        with self._lock:
            return [p.get('event') for t, p in self.triggers if t >= since]

    def take_trigger(self, event, since):
        """Oldest unconsumed trigger `event` received after `since`; removes it."""
        with self._lock:
            for i, (t, payload) in enumerate(self.triggers):
                if t >= since and payload.get('event') == event:
                    del self.triggers[i]
                    return payload
        return None

    def wait_trigger(self, event, since, timeout=None, cancelled=lambda: False):
        deadline = None if timeout is None else time.monotonic() + timeout
        with self._lock:
            while True:
                for i, (t, payload) in enumerate(self.triggers):
                    if t >= since and payload.get('event') == event:
                        del self.triggers[i]
                        return payload
                if cancelled():
                    return None
                left = None if deadline is None else deadline - time.monotonic()
                if left is not None and left <= 0:
                    return None
                self._lock.wait(0.2 if left is None else min(left, 0.2))

    def _on_robot_status(self, msg):
        with self._lock:
            for s in json.loads(msg.data):
                self.robot_status[s['robot']] = s

    # ------------------------------------------------------------- requests
    def request(self, payload, timeout=10.0):
        rid = f'm20_{uuid.uuid4().hex}'
        msg = ApiRequest(request_id=rid, json_msg=json.dumps(payload))
        self._req_pub.publish(msg)
        deadline = time.monotonic() + timeout
        with self._lock:
            while rid not in self._responses:
                left = deadline - time.monotonic()
                if left <= 0:
                    who = f' for robot {payload["robot"]}' if 'robot' in payload else ''
                    raise TaskError(f'no response to {payload.get("type")}{who} within {timeout}s: '
                                    'is the fleet adapter running, and does it serve that '
                                    'robot (RMF ignores requests for robots it does not know)?')
                self._lock.wait(left)
            return self._responses.pop(rid)

    def _submit(self, payload):
        resp = self.request(payload)
        if not resp.get('success', False):
            raise TaskError(f'RMF rejected task: {json.dumps(resp.get("errors", resp))}')
        state = resp.get('state') or {}
        tid = (state.get('booking') or {}).get('id')
        with self._lock:
            self.tasks.setdefault(tid, state)
        return tid

    def robot_task(self, robot, category, description, label=None, priority=None):
        """Assign a task to one named robot (queued behind its current task)."""
        req = {'category': category, 'description': description,
               'unix_millis_earliest_start_time': int(time.time() * 1000),
               'fleet_name': self.fleet}
        if label:
            req['labels'] = [label]
        if priority is not None:
            req['priority'] = {'type': 'binary', 'value': int(priority)}
        return self._submit({'type': 'robot_task_request', 'robot': robot,
                             'fleet': self.fleet, 'request': req})

    def dispatch_task(self, category, description, label=None):
        """Let RMF choose the robot by bidding (needs rmf_task_dispatcher)."""
        req = {'category': category, 'description': description,
               'unix_millis_earliest_start_time': int(time.time() * 1000)}
        if label:
            req['labels'] = [label]
        return self._submit({'type': 'dispatch_task_request', 'request': req})

    def compose(self, robot, activities, category='m20_mission', dispatch=False):
        desc = {'category': category, 'phases': [
            {'activity': {'category': 'sequence', 'description': {'activities': activities}}}]}
        if dispatch:
            return self.dispatch_task('compose', desc, label=category)
        return self.robot_task(robot, 'compose', desc, label=category)

    def cancel(self, task_id, labels=None, timeout=10.0):
        payload = {'type': 'cancel_task_request', 'task_id': task_id}
        if labels:
            payload['labels'] = labels
        return self.request(payload, timeout=timeout)

    def interrupt(self, task_id, why='m20 mission'):
        return self.request({'type': 'interrupt_task_request', 'task_id': task_id,
                             'labels': [why]})

    def resume(self, task_id):
        return self.request({'type': 'resume_task_request', 'for_task': task_id})

    # ------------------------------------------------------------- tracking
    def status(self, task_id):
        with self._lock:
            return (self.tasks.get(task_id) or {}).get('status')

    def active_tasks(self, robot=None):
        with self._lock:
            out = []
            for tid, st in self.tasks.items():
                if st.get('status') in TERMINAL:
                    continue
                who = (st.get('assigned_to') or {}).get('name')
                if robot is None or who == robot:
                    out.append(tid)
            return out

    def wait(self, task_ids, timeout=None, on_update=None, cancelled=None):
        """Block until every task is terminal. Returns {task_id: status}.
        Raises Aborted as soon as cancelled() is true."""
        task_ids = [t for t in task_ids if t]
        deadline = None if timeout is None else time.monotonic() + timeout
        with self._lock:
            while True:
                statuses = {t: (self.tasks.get(t) or {}).get('status') for t in task_ids}
                if all(s in TERMINAL for s in statuses.values()):
                    return statuses
                if cancelled is not None and cancelled():
                    raise Aborted()
                if on_update:
                    on_update(statuses)
                left = None if deadline is None else deadline - time.monotonic()
                if left is not None and left <= 0:
                    raise TaskError(f'timeout waiting for tasks: {statuses}')
                self._lock.wait(0.2 if left is None else min(left, 0.2))

    def event(self, text, **extra):
        self.events_pub.publish(String(data=json.dumps(
            {'robot': 'mission', 'text': text, 't': time.time(), **extra})))

    DISCOVERY = 1.5         # s a new process gives DDS to find the others

    def discovered(self):
        """Block until this client is old enough to have discovered the other nodes.
        A subscriber count alone cannot tell: this client subscribes to its own topics
        (/m20/trigger, /m20/mission_cmd), so the count is never 0, and a message sent at
        once from a fresh `m20 trigger` / `m20 stop` was lost. Free for long-lived
        processes (the GUI hub, a mission)."""
        left = self._born + self.DISCOVERY - time.monotonic()
        if left > 0:
            time.sleep(left)

    def publish_once(self, pub, msg, wait=3.0):
        """Publish a one-shot message once the others are discovered and wait until the
        subscribers have it. Returns the number of subscribers."""
        self.discovered()
        deadline = time.monotonic() + wait
        while pub.get_subscription_count() == 0 and time.monotonic() < deadline:
            time.sleep(0.05)
        pub.publish(msg)
        self.flush(pub)
        return pub.get_subscription_count()

    @staticmethod
    def flush(pub, timeout=1.0):
        """Wait until reliable subscribers acknowledged what was published."""
        from rclpy.duration import Duration
        try:
            pub.wait_for_all_acked(Duration(seconds=timeout))
        except Exception:  # noqa: BLE001 - older rclpy: a short grace period instead
            time.sleep(0.2)

    def close(self):
        # Stop spinning before tearing down, or rclpy aborts the process on exit.
        self._running = False
        self._thread.join(timeout=2.0)
        self._exec.shutdown()
        self.node.destroy_node()
        rclpy.try_shutdown()
