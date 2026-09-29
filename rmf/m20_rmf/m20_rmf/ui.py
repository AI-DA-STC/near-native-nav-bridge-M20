"""Demo operator console: status hub + web GUI.

    ros2 run m20_rmf ui            (or: ros2 launch m20_rmf demo.launch.py)
    open http://localhost:8080     (any device on the network: http://<laptop ip>:8080)

The hub merges the adapter's /m20/robot_status, RMF task states (/m20/task_states),
the mission runner's /m20/mission, inspection requests/results and operator signals
into one view (view.py) and publishes it on /m20/fleet_view for the RViz markers. The
web page renders the same view; its buttons send:

    stop         robot id or all   -> the no-drop stop of `m20 stop`
    signal       event (+ data)    -> /m20/trigger (what the mission waits for)
    verdict      request id + text -> /m20/inspect/result (stands in for the vision model)
    start/abort  mission file      -> runs `m20 mission <file>`; abort = Ctrl-C (robots stop)

HTTP on :8080 (static page), websocket on :8081 (view out, commands in).
"""

import argparse
import asyncio
import functools
import glob
import http.server
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time

from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from std_msgs.msg import String

from . import stack, view
from .sitefile import Site

MISSIONS_DIRS = ('/repo/rmf/m20_rmf/missions',)
HOLD_LAST_MODE = 3.0        # s a robot keeps its last mode between consecutive tasks


class Hub:
    """Collects everything the view needs; thread-safe snapshot()."""

    def __init__(self, fleet, missions_dirs):
        self.fleet = fleet
        self.rmf = fleet.rmf
        self.lock = threading.Lock()
        self.mission = {}
        self.stopped = set()
        self.inspections = {}           # request id -> {robot, target, label, t, verdict}
        self.timeline = []
        self.prev = {}                  # robot -> (mode, detail) for timeline changes
        self.last_active = {}           # robot -> (robot view, time) of its last task
        self.proc = None                # running `m20 mission`
        self.missions_dirs = missions_dirs
        node = self.rmf.node
        latched = QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE,
                             durability=DurabilityPolicy.TRANSIENT_LOCAL)
        node.create_subscription(String, '/m20/mission', self._on_mission, latched)
        node.create_subscription(String, '/m20/inspect/request', self._on_inspect_req, 10)
        node.create_subscription(String, '/m20/inspect/result', self._on_inspect_res, 10)
        node.create_subscription(String, '/m20/stop', self._on_stop, 10)
        node.create_subscription(String, '/m20/trigger', self._on_trigger, 10)
        self.view_pub = node.create_publisher(String, '/m20/fleet_view', 10)

    # ------------------------------------------------------------ inbound
    def note(self, text, kind='info'):
        with self.lock:
            self.timeline.append({'t': time.time(), 'text': text, 'kind': kind})
            del self.timeline[:-30]

    def _on_mission(self, msg):
        m = json.loads(msg.data)
        with self.lock:
            old = self.mission
            self.mission = m
        if m.get('phase') and m.get('phase') != old.get('phase'):
            self.note(m['phase'], 'phase')
        if m.get('state') != old.get('state') and m.get('state') in ('complete', 'aborted', 'failed'):
            self.note(f'mission {m.get("state")}' + (f': {m["error"]}' if m.get('error') else ''),
                      'alert' if m.get('state') != 'complete' else 'phase')

    def _on_inspect_req(self, msg):
        r = json.loads(msg.data)
        with self.lock:
            self.inspections[r['id']] = {'robot': r.get('robot'), 'target': r.get('target'),
                                         'label': r.get('label') or r.get('target'),
                                         't': time.time(), 'verdict': None}
            del_old = [k for k, v in self.inspections.items() if time.time() - v['t'] > 600]
            for k in del_old:
                del self.inspections[k]
        self.note(f'{r.get("robot")} inspecting {r.get("label") or r.get("target")}', 'alert')

    def _on_inspect_res(self, msg):
        r = json.loads(msg.data)
        verdict = r.get('verdict', 'done')
        with self.lock:
            ids = [r.get('id')] if r.get('id') in self.inspections else \
                [k for k, v in self.inspections.items() if v['verdict'] is None]
            for k in ids:
                self.inspections[k]['verdict'] = verdict
        self.note(f'verdict: {verdict}', 'alert')

    def _on_stop(self, msg):
        target = msg.data.strip()
        with self.lock:
            robots = self.fleet.robots if target in ('', 'all') else [target]
            self.stopped.update(robots)
        self.note(f'STOP {", ".join(robots)}', 'alert')

    def _on_trigger(self, msg):
        from .rmf_client import parse_trigger
        p = parse_trigger(msg.data)
        label = next((s.get('label') for s in self.mission.get('signals') or []
                      if s.get('event') == p['event']), p['event'])
        self.note(f'signal: {label}', 'signal')

    # ----------------------------------------------------------- the view
    def snapshot(self):
        with self.rmf._lock:
            statuses = [self.rmf.robot_status[r] for r in sorted(self.rmf.robot_status)
                        if r in self.fleet.robots]
            tasks = dict(self.rmf.tasks)
        with self.lock:
            pending = {k: v for k, v in self.inspections.items() if v['verdict'] is None}
            v = view.fleet_view(statuses, tasks, dict(self.mission), set(self.stopped),
                                list(self.timeline), pending)
        now = time.time()
        for r in v['robots']:
            # A stop lasts until the robot gets new work.
            if r['task'] is not None:
                self.stopped.discard(r['id'])
                self.last_active[r['id']] = (dict(r), now)
            elif r['mode'] == 'IDLE':
                # Consecutive steps leave a moment with no task; keep showing the last
                # activity for a few seconds instead of flashing IDLE in between.
                last, t = self.last_active.get(r['id'], (None, 0))
                if last is not None and now - t < HOLD_LAST_MODE:
                    r.update(mode=last['mode'], color=last['color'], detail=last['detail'])
            # The timeline only records what the cards cannot: a robot dropping out.
            was = self.prev.get(r['id'])
            if was is not None and (was == 'OFFLINE') != (r['mode'] == 'OFFLINE'):
                self.note(f'{r["id"]} {"offline" if r["mode"] == "OFFLINE" else "back online"}',
                          'alert')
            self.prev[r['id']] = r['mode']
        v['mission']['running'] = self.proc is not None and self.proc.poll() is None
        v['site'] = self.fleet.site.path
        return v

    # --------------------------------------------------------- commands
    def missions(self):
        out = []
        for d in self.missions_dirs:
            for f in sorted(glob.glob(os.path.join(d, '*.yaml'))):
                from .mission import check, load
                try:
                    ok = not check(load(f), self.fleet.site)
                except Exception:  # noqa: BLE001
                    ok = False
                if ok:
                    out.append({'file': f, 'name': os.path.splitext(os.path.basename(f))[0]})
        return out

    def command(self, c):
        kind = c.get('cmd')
        if kind == 'stop':
            robot = c.get('robot') or 'all'
            self.fleet.stop(None if robot == 'all' else [robot])
        elif kind == 'signal':
            self.fleet.trigger(c['event'], **(c.get('data') or {}))
        elif kind == 'verdict':
            body = {'id': c['id'], 'verdict': c['verdict']}
            self.rmf.publish_once(self.rmf.inspect_result_pub, String(data=json.dumps(body)), 1.0)
        elif kind == 'start':
            if self.proc is not None and self.proc.poll() is None:
                return {'error': 'a mission is already running'}
            exe = shutil.which('m20') or '/ws/install/m20_rmf/lib/m20_rmf/m20'
            args = [exe, '--site', self.fleet.site.path,
                    '--robots', ','.join(self.fleet.robots), 'mission', c['file']]
            log = open('/tmp/m20_mission.log', 'w')
            self.proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=log,
                                         stderr=subprocess.STDOUT, start_new_session=True)
            self.note(f'mission started: {os.path.basename(c["file"])}', 'phase')
        elif kind == 'abort':
            if self.proc is not None and self.proc.poll() is None:
                os.killpg(self.proc.pid, signal.SIGINT)     # runner stops every robot
            else:
                self.fleet.stop()
        return {'ok': True}


# --------------------------------------------------------------- servers
def serve_http(root, port):
    handler = functools.partial(QuietHandler, directory=root)
    http.server.ThreadingHTTPServer(('0.0.0.0', port), handler).serve_forever()


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


async def serve_ws(hub, port, period):
    import websockets
    clients = set()

    async def handler(ws, path=None):
        clients.add(ws)
        try:
            await ws.send(json.dumps({'type': 'missions', 'missions': hub.missions()}))
            async for raw in ws:
                try:
                    reply = await asyncio.get_running_loop().run_in_executor(
                        None, hub.command, json.loads(raw))
                except Exception as e:  # noqa: BLE001 - reported to the page
                    reply = {'error': str(e)}
                await ws.send(json.dumps({'type': 'reply', **(reply or {})}))
        finally:
            clients.discard(ws)

    async def broadcast():
        while True:
            v = hub.snapshot()
            data = json.dumps(v)
            hub.view_pub.publish(String(data=data))
            msg = json.dumps({'type': 'view', 'view': v})
            for ws in list(clients):
                try:
                    await ws.send(msg)
                except Exception:  # noqa: BLE001 - client went away
                    clients.discard(ws)
            await asyncio.sleep(period)

    async with websockets.serve(handler, '0.0.0.0', port, max_size=None):
        await broadcast()


def main(argv=None):
    from . import domain_guard
    argv = list(argv or sys.argv)
    domain_guard.check(argv=argv)
    import rclpy
    p = argparse.ArgumentParser(prog='m20_ui')
    p.add_argument('--site', default='')
    p.add_argument('--robots', default='')
    p.add_argument('--http-port', type=int, default=8080)
    p.add_argument('--ws-port', type=int, default=0, help='default: http port + 1')
    p.add_argument('--period', type=float, default=0.5)
    a = p.parse_args(rclpy.utilities.remove_ros_args(argv)[1:])
    a.ws_port = a.ws_port or a.http_port + 1      # the page connects to its port + 1

    cfg = stack.load()
    site_path = a.site or cfg.get('site')
    if not site_path:
        sys.exit('no site: pass --site or set site: in m20_stack.yaml')
    robots = [r for r in a.robots.split(',') if r] or stack.robots_for(site_path, cfg)
    from .primitives import Fleet
    fleet = Fleet(Site.load(site_path), robots=robots, log=lambda *x: None)

    # rclpy turns SIGTERM into a ROS shutdown but the web server's event loop would keep
    # running (and hold the ports); make SIGTERM end it like Ctrl-C. After rclpy.init.
    def _term(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, _term)
    missions_dirs = [d for d in MISSIONS_DIRS if os.path.isdir(d)] or \
        [os.path.join(os.path.dirname(site_path), '..', 'missions')]
    hub = Hub(fleet, missions_dirs)

    from ament_index_python.packages import get_package_share_directory
    root = os.path.join(get_package_share_directory('m20_rmf'), 'ui')
    threading.Thread(target=serve_http, args=(root, a.http_port), daemon=True).start()
    print(f'm20 ui: http://localhost:{a.http_port}  (robots {fleet.robots}, site {site_path})',
          flush=True)
    try:
        asyncio.run(serve_ws(hub, a.ws_port, a.period))
    except KeyboardInterrupt:
        pass
    finally:
        fleet.rmf.close()


if __name__ == '__main__':
    main()
