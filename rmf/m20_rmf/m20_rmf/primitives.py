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
| stop          | safe stop, robot stays standing: UDP cancel + adapter + RMF tasks |
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
from .rmf_client import RmfClient, TaskError
from .sitefile import Site


class Fleet:
    def __init__(self, site, robots=None, client=None, log=print):
        self.site = site if isinstance(site, Site) else Site.load(site)
        self.robots = [str(r) for r in (robots or self.site.robot_ids())]
        for r in self.robots:
            if r not in self.site.robots:
                raise ValueError(f'robot {r} is not in the site file')
        self.rmf = client or RmfClient(fleet=self.site.fleet['name'])
        self.log = log
        self.owned = {r: [] for r in self.robots}   # task ids we started, per robot
        self.background = []                        # task ids started with wait=False

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
        res = self.rmf.wait(tids, timeout=timeout)
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
            if not queue:
                self.cancel(r, quiet=True)
            tid = self.rmf.robot_task(r, 'patrol', {'places': places, 'rounds': int(rounds)},
                                      label=f'patrol:{rname}')
            self.owned[r].append(tid)
            tids.append(tid)
            self._say(f'{r} patrolling {rname} x{rounds} ({tid})')
        return self._finish(tids, wait, timeout, 'patrol')

    def go_to(self, robot, place, yaw=None, wait=True, queue=False, timeout=None):
        self.site.place(place)
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

    def explore(self, zone, robots=None, wait=True, timeout=None):
        """Robots enter the zone and each walks one track (tracks are dealt round-robin;
        with a flat `poses` list, the poses are split into contiguous chunks)."""
        robots = self._robots(robots)
        z = self.site.zones[zone]
        tids = []
        for i, r in enumerate(robots):
            desc = {'zone': zone}
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
            acts.append(self._perform('explore', desc, estimate_s=120))
            tids.append(self._start(r, acts, f'explore:{zone}', False))
        self._say(f'explore {zone} with {robots}')
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
                    self.rmf.cancel(tid)
                except TaskError as e:
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

    def stop(self, robots=None):
        """Stop robots where they stand, without dropping them.

        1. cancel navigation straight over UDP (works with RMF/adapter down),
        2. tell the adapter to drop its running action and current task,
        3. cancel every RMF task the robots have, so nothing re-sends a goal,
        4. cancel over UDP once more in case a goal slipped in meanwhile.
        """
        from std_msgs.msg import String
        robots = self._robots(robots)
        self._udp_to(robots, protocol.cancel_nav())
        for r in robots:
            self.rmf.publish_once(self.rmf.stop_pub, String(data=r), wait=0.5)
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

    def trigger(self, event='go'):
        from std_msgs.msg import String
        n = self.rmf.publish_once(self.rmf.trigger_pub, String(data=event))
        self._say(f'trigger "{event}" sent to {n} listener(s)')

    def wait_trigger(self, prompt=None, event=None, seconds=None):
        """Mission pause: ENTER on the console, a /m20/trigger event, or a timer."""
        if seconds is not None and event is None and prompt is None:
            self._say(f'waiting {seconds}s')
            time.sleep(float(seconds))
            return
        done = threading.Event()
        if event:
            from std_msgs.msg import String

            def cb(msg):
                try:
                    data = json.loads(msg.data).get('event', msg.data)
                except (ValueError, AttributeError):
                    data = msg.data
                if data == event:
                    done.set()
            sub = self.rmf.node.create_subscription(String, '/m20/trigger', cb, 10)
        if prompt is not None:
            def console():
                try:
                    input(f'>>> {prompt} [ENTER] ')
                except EOFError:
                    return
                done.set()
            threading.Thread(target=console, daemon=True).start()
        self._say(f'waiting for {"trigger " + event if event else "operator"}'
                  f'{f" (max {seconds}s)" if seconds else ""}')
        done.wait(None if seconds is None else float(seconds))
        if event:
            self.rmf.node.destroy_subscription(sub)

    def wait_tasks(self, timeout=None):
        tids, self.background = self.background, []
        return self._finish(tids, True, timeout, 'background tasks')
