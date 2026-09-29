"""Demo operator console: status hub + web GUI.

    ros2 run m20_rmf ui            (or: ros2 launch m20_rmf demo.launch.py)
    open http://localhost:8080     (any device on the network: http://<laptop ip>:8080)

The hub merges the adapter's /m20/robot_status, RMF task states (/m20/task_states),
the mission runner's /m20/mission, inspection requests/results and operator signals
into one view (view.py) and publishes it on /m20/fleet_view for the RViz markers. The
web page renders the same view, plus the RViz scene (the /m20/viz markers over
/m20/map, forwarded as-is and drawn top-down in the page); its buttons send:

    stop         robot id or all   -> the no-drop stop of `m20 stop`, which also ends the
                                      running mission (there is no separate abort)
    signal       event (+ data)    -> /m20/trigger (what the mission waits for)
    verdict      request id + text -> /m20/inspect/result (stands in for the vision model)
    start        mission file      -> /m20/mission_cmd, run by the mission host
                                      (`m20 mission-host`, the tmux "mission" pane, where
                                      Ctrl-C aborts it if this page is unavailable)

HTTP on :8080 (static page), websocket on :8081 (view out, commands in).
"""

import argparse
import array
import asyncio
import base64
import functools
import glob
import http.server
import json
import math
import os
import signal
import sys
import threading
import time

from nav_msgs.msg import OccupancyGrid
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from std_msgs.msg import String
from visualization_msgs.msg import Marker, MarkerArray

from . import protocol, stack, view
from .sitefile import Site

MISSIONS_DIRS = ('/repo/rmf/m20_rmf/missions',)
DASHBOARD_DIRS = ('/repo/rmf/m20_rmf/dashboard/dist',)
HOLD_LAST_MODE = 3.0        # s a robot keeps its last mode between consecutive tasks
STOPPED_FOR = 15.0          # s a stopped robot shows STOPPED before it reads IDLE
STALE = 4.0                 # s without a heartbeat before a mission / host counts as gone
SCENE_STALE = 2.0           # s without /m20/viz before robot markers drop (as in RViz)


def marker_json(m):
    """One visualization_msgs/Marker as the page draws it (top-down, map frame)."""
    p, q, c = m.pose.position, m.pose.orientation, m.color
    return {
        'ns': m.ns, 't': m.type,
        'p': [round(p.x, 3), round(p.y, 3), round(p.z, 3)],
        'yaw': round(math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y ** 2 + q.z ** 2)), 3),
        's': [round(m.scale.x, 3), round(m.scale.y, 3), round(m.scale.z, 3)],
        'c': [round(c.r * 255), round(c.g * 255), round(c.b * 255), round(c.a, 2)],
        'pts': [[round(v.x, 3), round(v.y, 3), round(v.z, 3)] for v in m.points],
        'txt': m.text,
    }


def grid_json(msg, version):
    """nav_msgs/OccupancyGrid -> the page's map layer (cells as base64 int8)."""
    info = msg.info
    return {'v': version, 'w': info.width, 'h': info.height, 'res': info.resolution,
            'origin': [info.origin.position.x, info.origin.position.y],
            'data': base64.b64encode(array.array('b', msg.data).tobytes()).decode()}


class Hub:
    """Collects everything the view needs; thread-safe snapshot()."""

    def __init__(self, fleet, missions_dirs):
        self.fleet = fleet
        self.rmf = fleet.rmf
        self.lock = threading.Lock()
        self.mission = {}
        self.stopped = {}               # robot -> time of its STOP
        self.inspections = {}           # request id -> {robot, target, label, t, verdict}
        self.timeline = []
        self.prev = {}                  # robot -> (mode, detail) for timeline changes
        self.last_active = {}           # robot -> (robot view, time) of its last task
        self.host = {}                  # last /m20/mission_host heartbeat
        self.aborted_at = 0.0           # time of the last "mission aborted" note
        self.lost_noted = None          # start time of the mission last noted as lost
        self.started = time.time()
        self.kick = None                # () -> push the view now (set by the ws server)
        self.missions_dirs = missions_dirs
        node = self.rmf.node
        latched = QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE,
                             durability=DurabilityPolicy.TRANSIENT_LOCAL)
        node.create_subscription(String, '/m20/mission', self._on_mission, latched)
        node.create_subscription(String, '/m20/inspect/request', self._on_inspect_req, 10)
        node.create_subscription(String, '/m20/inspect/result', self._on_inspect_res, 10)
        node.create_subscription(String, '/m20/stop', self._on_stop, 10)
        node.create_subscription(String, '/m20/trigger', self._on_trigger, 10)
        node.create_subscription(String, '/m20/mission_host', self._on_host, 10)
        # The RViz scene, for the page's map panel: the same markers and map RViz draws.
        self.scene = {'v': 0, 't': 0.0, 'markers': []}
        self.map = None
        node.create_subscription(MarkerArray, '/m20/viz', self._on_viz, 10)
        node.create_subscription(OccupancyGrid, '/m20/map', self._on_map, latched)
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
        if m.get('phase') and (m.get('phase') != old.get('phase') or
                               m.get('started') != old.get('started')):
            self.note(m['phase'], 'phase')
        if m.get('state') != old.get('state') and m.get('state') in ('complete', 'aborted', 'failed'):
            why = m.get('error') or (m.get('reason') if m.get('state') == 'aborted' else '')
            if m.get('state') == 'aborted':
                self.aborted_at = time.time()
            self.note(f'mission {m.get("state")}' + (f': {why}' if why else ''),
                      'alert' if m.get('state') != 'complete' else 'phase')
        if self.kick:
            self.kick()

    def _on_viz(self, msg):
        markers = []
        for m in msg.markers:
            if m.action == Marker.DELETEALL:
                markers = []
            elif m.action == Marker.ADD:
                markers.append(marker_json(m))
        with self.lock:
            self.scene = {'v': self.scene['v'] + 1, 't': time.time(), 'markers': markers}

    def _on_map(self, msg):
        with self.lock:
            self.map = grid_json(msg, (self.map or {}).get('v', 0) + 1)

    def scene_now(self):
        """Latest markers; robot markers vanish when viz stops, as their lifetime does."""
        with self.lock:
            s = self.scene
        if time.time() - s['t'] > SCENE_STALE:
            return {'v': -s['v'], 't': s['t'],     # a distinct version: resent once
                    'markers': [m for m in s['markers'] if not m['ns'].startswith('robots/')]}
        return s

    def _on_host(self, msg):
        h = json.loads(msg.data)
        with self.lock:
            self.host = h

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
        self.mark_stopped(self.fleet.robots if target in ('', 'all') else [target])

    def mark_stopped(self, robots):
        now = time.time()
        with self.lock:
            fresh = [r for r in robots if now - self.stopped.get(r, 0) > 1.0]
            self.stopped.update({r: now for r in robots})
            # During a mission the "mission aborted" line already says it; otherwise one
            # line per stop, though each robot gets its own /m20/stop message.
            quiet = self.mission.get('state') == 'running' or now - self.aborted_at < 3.0
            last = self.timeline[-1] if self.timeline else None
            if fresh and not quiet and last and last['text'].startswith('STOP ') \
                    and now - last['t'] < 1.5:
                last['text'] += ', ' + ', '.join(fresh)
                fresh = []
        if fresh and not quiet:
            self.note(f'STOP {", ".join(fresh)}', 'alert')
        if self.kick:
            self.kick()

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
        now = time.time()
        with self.lock:
            pending = {k: v for k, v in self.inspections.items() if v['verdict'] is None}
            # STOPPED shows for a while, then the robot reads IDLE again.
            for r, t in list(self.stopped.items()):
                if now - t > STOPPED_FOR:
                    del self.stopped[r]
            mission = dict(self.mission)
            host = dict(self.host)
            v = view.fleet_view(statuses, tasks, mission, set(self.stopped),
                                list(self.timeline), pending)
        for r in v['robots']:
            # A stop lasts until the robot gets new work.
            if r['task'] is not None and now - self.stopped.get(r['id'], 0) > 1.0:
                self.stopped.pop(r['id'], None)
                # Not while the latched task history replays at start-up: finished
                # tasks would flash by as if they were running.
                if now - self.started > 5.0:
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
        m = v['mission']
        # A mission whose process died (killed, crashed) stops re-publishing: show it as
        # lost instead of running forever, and let a new one start.
        if m.get('state') == 'running' and now - m.get('alive', 0) > STALE:
            m['state'] = 'lost'
            m['error'] = ('the mission process stopped responding; robots may still be '
                          'on their last task — STOP ALL if needed')
            if self.lost_noted != m.get('started'):
                self.lost_noted = m.get('started')
                self.note('mission lost: its process stopped responding', 'alert')
        m['running'] = m.get('state') == 'running'
        v['host'] = {'up': now - host.get('alive', 0) < STALE, 'busy': host.get('busy', False)}
        # An inspection that ended without a verdict (it timed out, or was stopped): the
        # robot has left INVESTIGATE, so stop asking the operator about it.
        modes = {r['id']: r['mode'] for r in v['robots']}
        for k, ins in list(v['inspections'].items()):
            if modes.get(ins['robot']) != 'INVESTIGATE' and now - ins['t'] > 3.0:
                with self.lock:
                    self.inspections[k]['verdict'] = 'none'
                del v['inspections'][k]
                self.note(f'{ins["robot"]}: inspection of {ins["label"]} ended without a verdict',
                          'alert')
        v['site'] = self.fleet.site.path
        return v

    # --------------------------------------------------------- commands
    def missions(self):
        """The missions that fit the site as it is now: the site file is read again, so
        a zone or place added since the GUI started counts (the list used to be checked
        against the site as it was at start-up)."""
        from .mission import check, load
        try:
            site = Site.load(self.fleet.site.path)
        except Exception:  # noqa: BLE001 - mid-edit / invalid: keep the last good one
            site = self.fleet.site
        out = []
        for d in self.missions_dirs:
            for f in sorted(glob.glob(os.path.join(d, '*.yaml'))):
                try:
                    ok = not check(load(f), site)
                except Exception:  # noqa: BLE001
                    ok = False
                if ok:
                    out.append({'file': f, 'name': os.path.splitext(os.path.basename(f))[0]})
        return out

    def command(self, c):
        kind = c.get('cmd')
        if kind == 'stop':
            # The robots stop now (UDP + adapter + mission abort, no waiting); clearing
            # their RMF tasks, which waits on RMF, finishes in the background.
            robot = c.get('robot') or 'all'
            robots = self.fleet.halt(None if robot == 'all' else [robot], source='GUI')
            self.mark_stopped(robots)
            threading.Thread(target=self._finish_stop, args=(robots,), daemon=True).start()
        elif kind == 'signal':
            data = c.get('data') or {}
            body = json.dumps({'event': c['event'], **data}) if data else c['event']
            self.rmf.trigger_pub.publish(String(data=body))
        elif kind == 'verdict':
            body = {'id': c['id'], 'verdict': c['verdict']}
            self.rmf.inspect_result_pub.publish(String(data=json.dumps(body)))
        elif kind == 'start':
            snap = self.snapshot()
            if snap['mission'].get('running'):
                return {'error': 'a mission is already running (STOP ALL ends it)'}
            if not snap['host']['up']:
                return {'error': 'no mission host: start the stack with scripts/m20_stack.sh '
                                 'up (tmux pane "mission"), or run `m20 mission-host`'}
            self.rmf.mission_cmd_pub.publish(String(data=json.dumps(
                {'cmd': 'start', 'file': c['file']})))
            self.note(f'mission requested: {os.path.basename(c["file"])}', 'phase')
        else:
            return {'error': f'unknown command {kind!r}'}
        if self.kick:
            self.kick()
        return {'ok': True}

    def _finish_stop(self, robots):
        try:
            self.fleet.cancel(robots, quiet=True)
        finally:
            self.fleet._udp_to(robots, protocol.cancel_nav())


# --------------------------------------------------------------- servers
def serve_http(root, port):
    handler = functools.partial(QuietHandler, directory=root)
    http.server.ThreadingHTTPServer(('0.0.0.0', port), handler).serve_forever()


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        # The dashboard is a single-page app: its tab addresses (/robots, /tasks) are
        # the page itself, so a reload or a shared link to a tab still works.
        name = self.path.split('?', 1)[0]
        if not os.path.exists(self.translate_path(name)) and '.' not in os.path.basename(name):
            self.path = '/index.html'
        super().do_GET()


async def serve_ws(hub, port, period):
    import websockets
    clients = set()

    loop = asyncio.get_running_loop()
    wake = asyncio.Event()
    # Commands and mission changes push the view at once instead of on the next tick.
    hub.kick = lambda: loop.call_soon_threadsafe(wake.set)

    sent = {}                   # ws -> (map version, scene version) it has

    async def handler(ws, path=None):
        clients.add(ws)
        sent[ws] = (0, 0)
        try:
            await ws.send(json.dumps({'type': 'missions', 'missions': hub.missions()}))
            async for raw in ws:
                try:
                    c = json.loads(raw)
                    reply = await loop.run_in_executor(None, hub.command, c)
                except Exception as e:  # noqa: BLE001 - reported to the page
                    c, reply = {}, {'error': str(e)}
                await ws.send(json.dumps({'type': 'reply', 'id': c.get('id'), **(reply or {})}))
        finally:
            clients.discard(ws)
            sent.pop(ws, None)

    listed = {'missions': None, 't': 0.0}

    async def broadcast():
        while True:
            # Missions and the site are edited while the GUI runs: refresh the Start
            # list in open pages when what fits changes (checked every 2 s).
            if time.monotonic() - listed['t'] > 2.0:
                listed['t'] = time.monotonic()
                ms = await loop.run_in_executor(None, hub.missions)
                if ms != listed['missions']:
                    changed = listed['missions'] is not None
                    listed['missions'] = ms
                    if changed:
                        out = json.dumps({'type': 'missions', 'missions': ms})
                        for ws in list(clients):
                            try:
                                await ws.send(out)
                            except Exception:  # noqa: BLE001
                                clients.discard(ws)
            v = hub.snapshot()
            data = json.dumps(v)
            hub.view_pub.publish(String(data=data))
            msg = json.dumps({'type': 'view', 'view': v})
            scene, grid = hub.scene_now(), hub.map
            scene_msg = map_msg = None
            for ws in list(clients):
                try:
                    await ws.send(msg)
                    mv, sv = sent.get(ws, (0, 0))
                    if grid is not None and grid['v'] != mv:
                        map_msg = map_msg or json.dumps({'type': 'map', 'map': grid})
                        await ws.send(map_msg)
                        mv = grid['v']
                    if scene['v'] != sv:
                        scene_msg = scene_msg or json.dumps({'type': 'scene', 'markers': scene['markers']})
                        await ws.send(scene_msg)
                        sv = scene['v']
                    sent[ws] = (mv, sv)
                except Exception:  # noqa: BLE001 - client went away
                    clients.discard(ws)
            wake.clear()
            try:
                await asyncio.wait_for(wake.wait(), period)
            except asyncio.TimeoutError:
                pass

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
    p.add_argument('--period', type=float, default=0.2)
    a = p.parse_args(rclpy.utilities.remove_ros_args(argv)[1:])
    a.ws_port = a.ws_port or a.http_port + 1      # the page connects to its port + 1

    cfg = stack.load()
    site_path = stack.path(a.site) or cfg.get('site')
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
    # The operator dashboard (Open-RMF's dashboard + our panels, dashboard/, built by
    # scripts/m20_stack.sh dashboard); the older standalone console if it is not built.
    root = next((d for d in DASHBOARD_DIRS if os.path.exists(os.path.join(d, 'index.html'))), None)
    if root is None:
        root = os.path.join(get_package_share_directory('m20_rmf'), 'ui')
        print('m20 ui: dashboard not built (scripts/m20_stack.sh dashboard): serving the '
              'older console', flush=True)
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
