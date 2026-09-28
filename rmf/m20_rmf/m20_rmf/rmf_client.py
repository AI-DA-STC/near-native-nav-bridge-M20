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


class TaskError(RuntimeError):
    pass


class RmfClient:
    def __init__(self, fleet='m20', node_name=None):
        if not rclpy.ok():
            rclpy.init()
        self.fleet = fleet
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
                    raise TaskError(f'no response to {payload.get("type")} within {timeout}s — '
                                    'is the fleet adapter / dispatcher running?')
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

    def cancel(self, task_id, labels=None):
        payload = {'type': 'cancel_task_request', 'task_id': task_id}
        if labels:
            payload['labels'] = labels
        return self.request(payload)

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

    def wait(self, task_ids, timeout=None, on_update=None):
        """Block until every task is terminal. Returns {task_id: status}."""
        task_ids = [t for t in task_ids if t]
        deadline = None if timeout is None else time.monotonic() + timeout
        with self._lock:
            while True:
                statuses = {t: (self.tasks.get(t) or {}).get('status') for t in task_ids}
                if all(s in TERMINAL for s in statuses.values()):
                    return statuses
                if on_update:
                    on_update(statuses)
                left = None if deadline is None else deadline - time.monotonic()
                if left is not None and left <= 0:
                    raise TaskError(f'timeout waiting for tasks: {statuses}')
                self._lock.wait(1.0 if left is None else min(left, 1.0))

    def event(self, text, **extra):
        self.events_pub.publish(String(data=json.dumps(
            {'robot': 'mission', 'text': text, 't': time.time(), **extra})))

    def publish_once(self, pub, msg, wait=3.0):
        """Publish a one-shot message after waiting (briefly) for a subscriber, so it is
        not lost to DDS discovery. Returns the number of subscribers it reached."""
        deadline = time.monotonic() + wait
        while pub.get_subscription_count() == 0 and time.monotonic() < deadline:
            time.sleep(0.05)
        pub.publish(msg)
        time.sleep(0.2)
        return pub.get_subscription_count()

    def close(self):
        # Stop spinning before tearing down, or rclpy aborts the process on exit.
        self._running = False
        self._thread.join(timeout=2.0)
        self._exec.shutdown()
        self.node.destroy_node()
        rclpy.try_shutdown()
