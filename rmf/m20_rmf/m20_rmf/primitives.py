"""Mission primitives: the vocabulary demos are written in.

Each primitive turns a demo intent into Open-RMF tasks for one or more robots, using
names from the site file. Mixed fleet/individual control falls out of the `robots`
argument: every primitive takes one robot, a list, or None (= all active robots).

Blocking primitives (default wait=True) return when every robot's task is terminal;
pass wait=False to get task ids back and join later with wait_tasks(). Unless
queue=True, a new task *preempts* the robot: its current and queued tasks are
cancelled first (RMF queues robot tasks otherwise — a patrol would never end).

    fleet = Fleet(Site.load('sites/lab.yaml'), robots=['834'])
    fleet.patrol()                          # each robot's own route, background
    fleet.form_up('muster')                 # barrier: all in their slots
    fleet.explore('new_area')               # split tracks across robots
    fleet.inspect('box1', robot='834')      # one robot, others hold
    fleet.form_up('muster'); fleet.patrol()

| primitive     | RMF realisation                                                  |
|---------------|------------------------------------------------------------------|
| patrol        | native patrol task (places x rounds) per robot                   |
| go_to         | compose: go_to_place (optional facing)                           |
| go_to_pose    | compose: perform_action goto_pose (off-graph)                    |
| form_up       | slot assignment (nearest/fixed) + go_to per robot + barrier      |
| explore       | compose: go_to_place entry -> perform_action explore (track i)   |
| inspect       | compose: go_to_place approach -> perform_action inspect          |
| action        | compose: [go_to_place] -> perform_action <any adapter action>    |
| hold          | compose: perform_action dwell                                    |
| turn_to       | compose: perform_action turn_to                                  |
| return_home   | go_to each robot's home                                          |
| relocalize    | direct /initialpose_set_relayed_<id> (works while RMF says lost) |
| cancel        | cancel_task_request for everything the robot has                 |
| stop          | safe stop, robot stays standing: UDP cancel + adapter + RMF tasks; |
|               | also ends the running mission (a stop is never undone by a step)  |
| estop         | vendor e-stop, robot DROPS; requires drop=True                    |
| signal        | event on /m20/events (lights/sound/dashboard hook)               |
| trigger       | publish /m20/trigger (releases wait_for_event actions)           |
| wait_trigger  | mission-side wait for ENTER, a /m20/events trigger, or seconds   |
| wait_tasks    | barrier on tasks started with wait=False                         |
"""

import itertools
import json
import math
import socket
import threading
import time

from . import protocol
from .rmf_client import Aborted, RmfClient, TaskError
from .sitefile import Site


class Fleet:
    def __init__(self, site, robots=None, client=None, log=print, console=True):
        self.site = site if isinstance(site, Site) else Site.load(site)
        self.robots = [str(r) for r in (robots or self.site.robot_ids())]
        for r in self.robots:
            if r in self.site.unplaced:
                raise ValueError(f'robot {r} has no home in the site yet: '
                                 f'm20 robot set {r} --home <place>')
            if r not in self.site.robots:
                raise ValueError(f'robot {r} is not in the site file')
        self.rmf = client or RmfClient(fleet=self.site.fleet['name'])
        self.log = log
        self.owned = {r: [] for r in self.robots}   # task ids we started, per robot
        self.background = []                        # task ids started with wait=False
        self.mission = {}                           # published on /m20/mission
        self.since = time.monotonic()               # triggers before this are ignored
        self.aborted = threading.Event()             # set by MissionRun.abort()
        self.console = console                      # wait_trigger also takes ENTER
        self._mission_lock = threading.Lock()

    def publish_mission(self, **changes):
        """Update and publish the mission state the status hub / GUI show. `alive` is
        refreshed on every publish (the runner re-publishes every second), so the GUI
        can tell a running mission from one whose process died."""
        from std_msgs.msg import String
        with self._mission_lock:
            self.mission.update(changes)
            self.mission['robots'] = self.robots
            self.mission['alive'] = time.time()
            self.mission['queued'] = self.rmf.pending_triggers(self.since) \
                if hasattr(self.rmf, 'pending_triggers') else []
            data = json.dumps(self.mission)
        try:
            self.rmf.mission_pub.publish(String(data=data))
        except Exception:  # noqa: BLE001 - display only
            pass

    def check_abort(self):
        if self.aborted.is_set():
            raise Aborted()

    def sleep(self, seconds):
        """time.sleep that ends early (raising Aborted) when the mission is aborted."""
        if self.aborted.wait(float(seconds)):
            raise Aborted()

    # --------------------------------------------------------------- helpers
    def _robots(self, robots):
        if robots is None or robots == 'all':
            return list(self.robots)
        if isinstance(robots, (str, int)):
            robots = [robots]
        out = [str(r) for r in robots]
        missing = [r for r in out if r not in self.robots]
        if missing:
            raise ValueError(f'robots {missing} not active (active: {self.robots})')
        return out

    def _say(self, text):
        self.log(f'[mission] {text}')
        self.rmf.event(text)

    def _start(self, robot, activities, label, queue):
        self.check_abort()          # never start new work after a stop
        if not queue:
            self.cancel(robot, quiet=True)
        tid = self.rmf.compose(robot, activities, category=label)
        self.owned[robot].append(tid)
        return tid

    def _finish(self, tids, wait, timeout, what):
        tids = [t for t in tids if t]
        if not wait:
            self.background.extend(tids)
            return tids
        res = self.rmf.wait(tids, timeout=timeout, cancelled=self.aborted.is_set)
        self.check_abort()          # tasks ended by the stop itself: not a step result
        bad = {t: s for t, s in res.items() if s != 'completed'}
        if bad:
            self._say(f'{what}: not all tasks completed: {bad}')
        else:
            self._say(f'{what}: done')
        return res

    @staticmethod
    def _place(name, yaw=None):
        return name if yaw is None else {'waypoint': name, 'orientation': float(yaw)}

    @staticmethod
    def _perform(category, description, estimate_s=60):
        return {'category': 'perform_action', 'description': {
            'unix_millis_action_duration_estimate': int(estimate_s * 1000),
            'category': category, 'description': description, 'use_tool_sink': False}}

    # ------------------------------------------------------------ primitives
    def patrol(self, robots=None, route=None, rounds=1000, wait=False, queue=False, timeout=None):
        """Each robot patrols `route` (default: its own route from the site)."""
        tids = []
        for r in self._robots(robots):
            rname = route or self.site.robots[r].get('route')
            if not rname:
                raise ValueError(f'robot {r} has no route; pass route=')
            places = self.site.routes[rname]
            self.check_abort()
            if not queue:
                self.cancel(r, quiet=True)
            tid = self.rmf.robot_task(r, 'patrol', {'places': places, 'rounds': int(rounds)},
                                      label=f'patrol:{rname}')
            self.owned[r].append(tid)
            tids.append(tid)
            self._say(f'{r} patrolling {rname} x{rounds} ({tid})')
        return self._finish(tids, wait, timeout, 'patrol')

    def go_to(self, robot, place, yaw=None, face='place', wait=True, queue=False, timeout=None):
        """Go to a place. It ends facing the place's own yaw from the site file
        (face='place', default), the direction it arrived from (face='travel', RMF's
        default), or `yaw` if given."""
        x, y, place_yaw = self.site.place(place)
        if yaw is None and face == 'place':
            yaw = place_yaw
        tids = [self._start(r, [{'category': 'go_to_place', 'description': self._place(place, yaw)}],
                            f'go_to:{place}', queue) for r in self._robots(robot)]
        self._say(f'{robot} -> {place}')
        return self._finish(tids, wait, timeout, f'go_to {place}')

    def go_to_pose(self, robot, pose, check_yaw=False, ret=False, wait=True, queue=False,
                   timeout=None):
        pose = self.site.resolve_pose(pose)
        tids = [self._start(r, [self._perform('goto_pose', {
            'pose': pose, 'check_yaw': check_yaw, 'return': ret})], 'go_to_pose', queue)
            for r in self._robots(robot)]
        return self._finish(tids, wait, timeout, f'go_to_pose {pose}')

    def assign_slots(self, formation, robots):
        f = self.site.formations[formation]
        slots = f['slots']
        if len(robots) > len(slots):
            raise ValueError(f'formation {formation} has {len(slots)} slots for {len(robots)} robots')
        if f['assign'] == 'fixed':
            return dict(zip(robots, slots))
        poses = {r: (self.rmf.robot_status.get(r) or {}).get('pose') for r in robots}
        if any(p is None for p in poses.values()):
            self._say(f'no pose for some robots {poses}; using fixed slot order')
            return dict(zip(robots, slots))
        best, best_cost = None, math.inf
        for perm in itertools.permutations(slots, len(robots)):
            cost = sum(math.hypot(poses[r][0] - self.site.places[s][0],
                                  poses[r][1] - self.site.places[s][1])
                       for r, s in zip(robots, perm))
            if cost < best_cost:
                best, best_cost = dict(zip(robots, perm)), cost
        return best

    def form_up(self, formation, robots=None, wait=True, face=True, timeout=None):
        """Send robots to the formation's slots; with wait=True, a barrier until all arrive."""
        robots = self._robots(robots)
        slots = self.assign_slots(formation, robots)
        self._say(f'form up {formation}: {slots}')
        tids = []
        for r, s in slots.items():
            yaw = self.site.places[s][2] if face else None
            tids.append(self._start(r, [{'category': 'go_to_place',
                                         'description': self._place(s, yaw)}],
                                    f'form_up:{formation}', False))
        return self._finish(tids, wait, timeout, f'form_up {formation}')

    def explore(self, zone, robots=None, seconds=None, wait=True, timeout=None):
        """Robots enter the zone and each walks one track (tracks are dealt round-robin;
        with a flat `poses` list, or a `boundary` sweep, the poses are split into
        contiguous chunks). Each robot ends at the zone's `exit` place (default: its
        entry). `seconds`: time limit from the zone entry; when it runs out each robot
        stops and walks to the exit, and the step ends normally."""
        robots = self._robots(robots)
        z = self.site.zones[zone]
        tids = []
        for i, r in enumerate(robots):
            desc = {'zone': zone}
            if seconds:
                desc['seconds'] = float(seconds)
            if z['tracks']:
                desc['track'] = i % len(z['tracks'])
            else:
                n = len(z['poses'])
                chunk = z['poses'][i * n // len(robots):(i + 1) * n // len(robots)]
                if not chunk:
                    continue
                desc['poses'] = chunk
            acts = []
            if z['entry']:
                acts.append({'category': 'go_to_place', 'description': z['entry']})
            acts.append(self._perform('explore', desc, estimate_s=float(seconds or 120)))
            tids.append(self._start(r, acts, f'explore:{zone}', False))
        self._say(f'explore {zone} with {robots}' + (f' for up to {seconds:g} s' if seconds else ''))
        return self._finish(tids, wait, timeout, f'explore {zone}')

    def inspect(self, target, robot, wait=True, timeout=None):
        t = self.site.targets[target]
        acts = []
        if t['approach']:
            acts.append({'category': 'go_to_place', 'description': t['approach']})
        acts.append(self._perform('inspect', {'target': target}, estimate_s=t['timeout'] + 30))
        tids = [self._start(r, acts, f'inspect:{target}', False) for r in self._robots(robot)]
        self._say(f'{robot} inspecting {target}')
        return self._finish(tids, wait, timeout, f'inspect {target}')

    def action(self, robot, category, description=None, at=None, wait=True, queue=False,
               timeout=None):
        """Any adapter action, optionally after going to a place (`at`)."""
        acts = []
        if at:
            acts.append({'category': 'go_to_place', 'description': at})
        acts.append(self._perform(category, description or {}))
        tids = [self._start(r, acts, f'action:{category}', queue) for r in self._robots(robot)]
        return self._finish(tids, wait, timeout, f'action {category}')

    def hold(self, robots=None, seconds=10.0, wait=True):
        return self.action(robots, 'dwell', {'seconds': seconds}, wait=wait)

    def turn_to(self, robot, yaw=None, look_at=None, target=None, wait=True):
        d = {k: v for k, v in (('yaw', yaw), ('look_at', look_at), ('target', target)) if v is not None}
        return self.action(robot, 'turn_to', d, wait=wait)

    def return_home(self, robots=None, wait=True, timeout=None):
        tids = []
        for r in self._robots(robots):
            home = self.site.robots[r]['home']
            tids.append(self._start(r, [{'category': 'go_to_place', 'description': home}],
                                    'return_home', False))
        self._say('returning home')
        return self._finish(tids, wait, timeout, 'return_home')

    def relocalize(self, robot, where):
        """Set the robot's SLAM pose directly (RViz '2D Pose Estimate' equivalent)."""
        from geometry_msgs.msg import PoseWithCovarianceStamped
        x, y, yaw = self.site.resolve_pose(where)
        pub = self.rmf.node.create_publisher(
            PoseWithCovarianceStamped, f'/initialpose_set_relayed_{robot}', 10)
        msg = PoseWithCovarianceStamped()
        msg.header.frame_id = 'map'
        msg.pose.pose.position.x, msg.pose.pose.position.y = float(x), float(y)
        msg.pose.pose.orientation.z, msg.pose.pose.orientation.w = math.sin(yaw / 2), math.cos(yaw / 2)
        cov = [0.0] * 36
        cov[0] = cov[7] = 0.25
        cov[35] = 0.07
        msg.pose.covariance = cov
        deadline = time.monotonic() + 3.0   # let discovery find the robot's relay
        while pub.get_subscription_count() == 0 and time.monotonic() < deadline:
            time.sleep(0.05)
        if pub.get_subscription_count() == 0:
            self._say(f'warning: nothing subscribes to /initialpose_set_relayed_{robot} — '
                      'is the initialpose_set relay running on the robot?')
        for _ in range(3):
            msg.header.stamp = self.rmf.node.get_clock().now().to_msg()
            pub.publish(msg)
            time.sleep(0.3)
        self._say(f'{robot} relocalized to ({x:.2f}, {y:.2f}, {yaw:.2f})')

    def cancel(self, robots=None, quiet=False):
        for r in self._robots(robots):
            tids = set(self.owned.get(r, [])) | set(self.rmf.active_tasks(r))
            for tid in tids:
                if self.rmf.status(tid) in ('completed', 'failed', 'canceled', 'killed', 'skipped'):
                    continue
                try:
                    self.rmf.cancel(tid, timeout=3.0)
                except TaskError as e:
                    # A stop cancels from several places at once (GUI, mission, adapter);
                    # only a task that is still live is worth reporting.
                    if self.rmf.status(tid) not in ('completed', 'failed', 'canceled',
                                                    'killed', 'skipped'):
                        self._say(f'cancel {tid} failed: {e}')
            if not quiet:
                self._say(f'{r}: cancelled {len(tids)} task(s)')

    def _udp_to(self, robots, payload, repeats=3):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        for r in robots:
            cfg = self.site.robots[r]
            for i in range(repeats):
                s.sendto(protocol.encode(payload, i), (cfg['ip'], int(cfg.get('port', 30000))))
        s.close()

    def halt(self, robots=None, end_mission=True, source=''):
        """The immediate part of stop(), no waiting on RMF: cancel navigation over UDP
        (works with RMF/adapter down), tell the adapter to drop the robots' running
        action and current task, and abort the running mission (if end_mission)."""
        from std_msgs.msg import String
        robots = self._robots(robots)
        self._udp_to(robots, protocol.cancel_nav())
        # The robots are already stopping (UDP). A fresh `m20 stop` process now waits
        # for discovery, or the adapter and the mission would never hear it.
        if hasattr(self.rmf, 'discovered'):
            self.rmf.discovered()
        for r in robots:
            self.rmf.stop_pub.publish(String(data=r))
        if end_mission:
            who = 'ALL' if set(robots) == set(self.robots) else ', '.join(robots)
            self.rmf.mission_cmd_pub.publish(String(data=json.dumps(
                {'cmd': 'abort', 'reason': f'STOP {who}' + (f' ({source})' if source else '')})))
        if hasattr(self.rmf, 'flush'):
            self.rmf.flush(self.rmf.stop_pub, 0.5)
            if end_mission:
                self.rmf.flush(self.rmf.mission_cmd_pub, 0.5)
        return robots

    def stop(self, robots=None, end_mission=True, source=''):
        """Stop robots where they stand, without dropping them, and end the mission.

        1. halt(): UDP cancel, adapter stop, abort the running mission,
        2. cancel every RMF task the robots have, so nothing re-sends a goal,
        3. cancel over UDP once more in case a goal slipped in meanwhile.
        """
        robots = self.halt(robots, end_mission, source)
        try:
            self.cancel(robots, quiet=True)
        finally:
            self._udp_to(robots, protocol.cancel_nav())
        self._say(f'STOP {robots}: navigation and tasks cancelled (robots stay standing)')

    def estop(self, robots=None, drop=False):
        """Vendor e-stop: the robot DROPS to the ground. Needs drop=True; use stop()."""
        if not drop:
            raise ValueError('the vendor e-stop drops the robot; use stop(), or pass drop=True')
        robots = self._robots(robots)
        self._udp_to(robots, protocol.estop(), repeats=1)
        self._say(f'E-STOP (robot drops) {robots}')

    def signal(self, event, data=None):
        self.rmf.event(f'signal {event}', signal=event, data=data)

    def trigger(self, event='go', **data):
        from std_msgs.msg import String
        body = json.dumps({'event': event, **data}) if data else event
        n = self.rmf.publish_once(self.rmf.trigger_pub, String(data=body))
        self._say(f'trigger "{event}" sent to {n} listener(s)')

    def wait_trigger(self, prompt=None, event=None, seconds=None, label=None):
        """Mission pause until an operator signal, ENTER on the console, or a timer.

        `event`: a /m20/trigger name (the GUI shows `label` or `prompt` as its button;
        `m20 trigger <event>` works too). Signals sent earlier in the mission count:
        they are buffered. Returns the signal's payload (dict) or None on timeout/ENTER.
        """
        if seconds is not None and event is None and prompt is None:
            self._say(f'waiting {seconds}s')
            self.sleep(seconds)
            return None
        # A bare prompt is answered by the GUI's button (signal "continue") or ENTER.
        event = event or 'continue'
        entered = threading.Event()
        if prompt is not None and self.console:
            def console():
                try:
                    input(f'>>> {prompt} [ENTER] ')
                except EOFError:
                    return
                entered.set()
            threading.Thread(target=console, daemon=True).start()
        self._say(f'waiting for signal {event}'
                  f'{f" (max {seconds}s)" if seconds else ""}')
        self.publish_mission(waiting={'event': event, 'prompt': prompt or '',
                                      'label': label or prompt or event or 'Continue',
                                      'seconds': seconds, 'since': time.time()})
        try:
            payload = self.rmf.wait_trigger(
                event, self.since, None if seconds is None else float(seconds),
                cancelled=lambda: entered.is_set() or self.aborted.is_set())
            self.check_abort()
            if payload is not None:
                self._say(f'signal {event} received')
            return payload
        finally:
            self.publish_mission(waiting=None)

    def wait_tasks(self, timeout=None):
        tids, self.background = self.background, []
        return self._finish(tids, True, timeout, 'background tasks')
