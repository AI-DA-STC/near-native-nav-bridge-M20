"""Mission runner: a demo is a YAML list of primitive calls.

    name: visitor_demo
    steps:
      - patrol: {}                              # all robots, own routes, background
      - wait_trigger: {prompt: "Start formation?"}
      - form_up: {formation: muster}
      - explore: {zone: new_area}
      - inspect: {target: box1, robot: "834"}
      - form_up: {formation: muster}
      - patrol: {}

Each step is `{primitive: {kwargs}}` where primitive is any Fleet method (see
primitives.py), plus these control steps:

    - parallel: [step, step, ...]         run concurrently, continue when all finish
    - repeat: {times: 3, steps: [...]}    loop (times: forever = until the mission is stopped)
    - log: "text"                         narrate to console + /m20/events
    - phase: "Patrolling"                 the stage shown big in the GUI (also logged)
    - sleep: 5                            plain delay

Operator signals: `wait_trigger: {event: suspicious, label: "Suspicious item"}` pauses
until the GUI button / `m20 trigger suspicious` (signals sent earlier in the mission
count). A signal may carry data, used by later steps as `${event.key}`:

    signals:                                  # buttons the GUI offers during the mission
      - {event: suspicious, label: "Suspicious item at box 1", data: {target: box1}}
    steps:
      - wait_trigger: {event: suspicious, label: "Report suspicious item"}
      - inspect: {target: "${suspicious.target}", robot: "834"}

Stopping: any STOP (GUI, `m20 stop`, Ctrl-C in the mission's terminal) aborts the
mission and stops its robots where they stand; nothing resumes by itself. Missions
started from the GUI run in the mission host (`m20 mission-host`, the tmux "mission"
pane), so that pane is where Ctrl-C works when the GUI does not.

`robot` / `robots` may name robots that are not active in this run (e.g. a 3-robot
mission tested with one dog): missing robots are dropped from lists, and a single
`robot` falls back to the first active robot, with a notice. `--check` validates
every name against the site without touching RMF.
"""

import argparse
import json
import os
import sys
import threading
import time

import yaml

from .rmf_client import Aborted
from .sitefile import Site

CONTROL = {'parallel', 'repeat', 'log', 'sleep', 'phase'}
ROBOT_ARGS = {'robot', 'robots'}


class MissionError(ValueError):
    pass


def load(path):
    with open(path) as f:
        data = yaml.safe_load(f) or {}
    if 'steps' not in data or not isinstance(data['steps'], list):
        raise MissionError(f'{path}: needs a `steps:` list')
    return data


def _split(step):
    if not isinstance(step, dict) or len(step) != 1:
        raise MissionError(f'each step must be a single-key mapping, got {step!r}')
    (name, args), = step.items()
    return name, args


class Runner:
    def __init__(self, fleet, log=print):
        self.fleet = fleet
        self.log = log
        self.signals = {}           # event -> payload of the last signal received

    def _resolve(self, value):
        """Replace '${event.key}' strings with data from received signals."""
        if isinstance(value, dict):
            return {k: self._resolve(v) for k, v in value.items()}
        if isinstance(value, list):
            return [self._resolve(v) for v in value]
        if isinstance(value, str) and value.startswith('${') and value.endswith('}'):
            event, _, key = value[2:-1].partition('.')
            payload = self.signals.get(event)
            if payload is None or (key and key not in payload):
                raise MissionError(f'{value}: no signal {event!r} with {key!r} received yet')
            return payload[key] if key else payload
        return value

    # Resolve robot arguments against the robots active in this run.
    def _fit_robots(self, name, kwargs):
        active = self.fleet.robots
        for key in ROBOT_ARGS & kwargs.keys():
            v = kwargs[key]
            if v in (None, 'all'):
                continue
            wanted = [str(x) for x in (v if isinstance(v, list) else [v])]
            kept = [r for r in wanted if r in active]
            if key == 'robot' and not kept:
                self.log(f'[mission] {name}: robot {wanted} not active, using {active[0]}')
                kept = [active[0]]
            if not kept:
                self.log(f'[mission] {name}: none of {wanted} active, skipping')
                return None
            kwargs[key] = kept if isinstance(v, list) or key == 'robots' else kept[0]
        return kwargs

    def run_steps(self, steps, depth=0):
        for i, step in enumerate(steps):
            self.fleet.check_abort()
            name, args = _split(step)
            prefix = '  ' * depth
            if name == 'log':
                self.fleet._say(str(args))
            elif name == 'phase':
                self.fleet._say(str(args))
                self.fleet.publish_mission(phase=str(args))
            elif name == 'sleep':
                self.fleet.sleep(float(args))
            elif name == 'parallel':
                errors = []

                def run(s):
                    try:
                        self.run_steps([s], depth + 1)
                    except Exception as e:  # noqa: BLE001 - reported after the join
                        errors.append(e)
                threads = [threading.Thread(target=run, args=(s,)) for s in args]
                for t in threads:
                    t.start()
                for t in threads:
                    t.join()
                if errors:
                    raise errors[0]
            elif name == 'repeat':
                times = args.get('times', 1)
                forever = str(times).lower() == 'forever'
                n = 0
                while forever or n < int(times):
                    self.fleet.check_abort()
                    n += 1
                    self.log(f'{prefix}[mission] repeat {n}/{"forever" if forever else times}')
                    self.run_steps(args['steps'], depth + 1)
            else:
                fn = getattr(self.fleet, name, None)
                if fn is None or name.startswith('_'):
                    raise MissionError(f'unknown primitive {name!r}')
                kwargs = dict(args or {}) if isinstance(args, dict) else {}
                kwargs = self._fit_robots(name, self._resolve(kwargs))
                if kwargs is None:
                    continue
                if name == 'stop':
                    kwargs.setdefault('end_mission', False)     # a planned stop step
                self.log(f'{prefix}[mission] step: {name} {kwargs}')
                result = fn(**kwargs)
                if name == 'wait_trigger' and isinstance(result, dict):
                    self.signals[result.get('event', '')] = result
                    self.fleet.publish_mission(used=sorted(self.signals))


def check(mission, site):
    """Validate names in a mission against a site. Returns a list of problems."""
    problems = []
    lookups = {
        'formation': site.formations, 'zone': site.zones, 'target': site.targets,
        'route': site.routes, 'place': site.places,
    }

    def walk(steps):
        for step in steps:
            try:
                name, args = _split(step)
            except MissionError as e:
                problems.append(str(e))
                continue
            if name == 'parallel':
                walk(args)
            elif name == 'repeat':
                t = args.get('times', 1)
                if str(t).lower() != 'forever' and not (isinstance(t, int) and t >= 0):
                    problems.append(f'repeat: times must be a number or forever, got {t!r}')
                walk(args.get('steps', []))
            elif name in CONTROL:
                continue
            elif isinstance(args, dict):
                for key, table in lookups.items():
                    v = args.get(key)
                    if isinstance(v, str) and v.startswith('${'):
                        continue            # filled from a signal at run time
                    if key in args and v not in table:
                        problems.append(f'{name}: unknown {key} {args[key]!r}')
                z = site.zones.get(args.get('zone')) if name == 'explore' else None
                if z is not None and not z['tracks'] and not z['poses']:
                    problems.append(f'explore: zone {args["zone"]} has nothing to walk yet '
                                    '(a boundary needs 3+ corners and room for one row)')
                for key in ROBOT_ARGS & args.keys():
                    v = args[key]
                    for r in (v if isinstance(v, list) else [v]):
                        if r not in (None, 'all') and str(r) not in site.robots:
                            problems.append(f'{name}: unknown robot {r!r}')
    walk(mission['steps'])
    return problems


class MissionRun:
    """One mission running on a worker thread. abort() may be called from any thread
    (Ctrl-C, a STOP from the GUI or CLI): it stops the robots and the worker ends at
    its next check, within ~0.2 s of whatever it was waiting on."""

    HEARTBEAT = 1.0             # s between re-publishes of the state (GUI staleness)

    def __init__(self, fleet, mission, file):
        self.fleet = fleet
        self.mission = mission
        self.file = file
        self.name = mission.get('name') or os.path.splitext(os.path.basename(file))[0]
        self.done = threading.Event()
        self._abort_lock = threading.Lock()
        self.reason = None

    def start(self):
        f = self.fleet
        f.rmf.on_trigger = f.publish_mission            # show queued signals in the GUI
        f._say(f'mission {self.name} start, robots {f.robots}')
        f.publish_mission(name=self.name, file=self.file, state='running',
                          started=time.time(), phase='', waiting=None, ended=None,
                          error=None, used=[], signals=self.mission.get('signals') or [],
                          description=self.mission.get('description', ''))
        threading.Thread(target=self._body, daemon=True, name='mission').start()
        threading.Thread(target=self._heartbeat, daemon=True).start()
        return self

    def _heartbeat(self):
        while not self.done.wait(self.HEARTBEAT):
            self.fleet.publish_mission()

    def _body(self):
        f = self.fleet
        try:
            Runner(f).run_steps(self.mission['steps'])
            f.check_abort()
            f._say('mission complete')
            f.publish_mission(state='complete', waiting=None, ended=time.time())
        except Aborted:
            pass                                # abort() published the state
        except Exception as e:  # noqa: BLE001 - shown in the GUI and the terminal
            if f.aborted.is_set():
                pass
            else:
                f._say(f'mission failed: {e}')
                f.publish_mission(state='failed', error=str(e), waiting=None,
                                  ended=time.time())
        finally:
            self.done.set()

    def abort(self, reason='operator'):
        """Stop the robots and end the mission. Idempotent; returns at once when the
        mission already ended."""
        with self._abort_lock:
            if self.done.is_set() or self.fleet.aborted.is_set():
                return
            self.fleet.aborted.set()
            self.reason = reason
        f = self.fleet
        f.publish_mission(state='aborted', reason=reason, waiting=None, ended=time.time())
        f._say(f'mission aborted ({reason}): stopping {f.robots}, robots stay standing')
        try:
            f.stop(end_mission=False)
        finally:
            f.publish_mission(state='aborted')

    def wait(self, timeout=None):
        return self.done.wait(timeout)


def _load_checked(file, site):
    mission = load(file)
    problems = check(mission, site)
    if problems:
        raise MissionError('mission check failed:\n  ' + '\n  '.join(problems))
    return mission


def main(argv=None):
    """`m20 mission <file>`: run one mission in this terminal. Ctrl-C aborts it
    (robots stop, standing); a STOP from the GUI or `m20 stop` aborts it too."""
    import rclpy
    from . import domain_guard
    argv = list(argv or sys.argv)
    domain_guard.check(argv=argv)
    p = argparse.ArgumentParser(prog='m20_mission')
    p.add_argument('mission')
    p.add_argument('--site', required=True)
    p.add_argument('--robots', default='', help='comma list of active robots (default: all)')
    p.add_argument('--check', action='store_true', help='validate only')
    a = p.parse_args(rclpy.utilities.remove_ros_args(argv)[1:])
    from . import stack
    a.site, a.mission = stack.path(a.site), stack.path(a.mission)
    site = Site.load(a.site)
    try:
        mission = _load_checked(a.mission, site)
    except MissionError as e:
        sys.exit(str(e))
    if a.check:
        print(f'{a.mission}: OK ({len(mission["steps"])} steps)')
        return
    import signal
    from .primitives import Fleet

    def _term(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, _term)
    robots = [r for r in a.robots.split(',') if r] or None
    fleet = Fleet(site, robots=robots)
    run = MissionRun(fleet, mission, a.mission)

    def on_cmd(cmd):
        if cmd.get('cmd') == 'abort':
            threading.Thread(target=run.abort, args=(cmd.get('reason') or 'STOP',),
                             daemon=True).start()
    fleet.rmf.on_mission_cmd = on_cmd
    run.start()
    try:
        while not run.wait(0.2):
            pass
    except KeyboardInterrupt:
        print('\n[mission] Ctrl-C: aborting, stopping robots (Ctrl-C again to quit now)',
              flush=True)
        try:
            run.abort('Ctrl-C')
            run.wait(10.0)
        except KeyboardInterrupt:
            pass
    finally:
        time.sleep(0.3)     # let the last mission state go out
        fleet.rmf.close()
    if fleet.mission.get('state') == 'failed':
        sys.exit(1)


class MissionHost:
    """Runs missions on request from the GUI (/m20/mission_cmd), in-process, one at a
    time, and tells the GUI it is there (/m20/mission_host, every second)."""

    def __init__(self, site_path, robots, client, log=print):
        self.site_path = site_path
        self.robots = robots
        self.rmf = client
        self.log = log
        self.run = None
        self.lock = threading.Lock()
        from std_msgs.msg import String
        self._String = String
        self.pub = client.node.create_publisher(String, '/m20/mission_host', 10)
        self.others = set()             # pids of other hosts heard on /m20/mission_host
        client.node.create_subscription(String, '/m20/mission_host', self._on_host, 10)

    def listen(self):
        """Start taking commands, unless another host is already running: two hosts
        would both run every mission the GUI starts."""
        time.sleep(2.5)                 # discovery + one heartbeat period
        if self.others:
            raise MissionError(f'another mission host is running (pid {sorted(self.others)}); '
                               'use that one, or stop it first')
        self.rmf.on_mission_cmd = self._on_cmd

    def _on_host(self, msg):
        pid = json.loads(msg.data).get('pid')
        if pid != os.getpid():
            self.others.add(pid)

    @property
    def busy(self):
        return self.run is not None and not self.run.done.is_set()

    def _on_cmd(self, cmd):
        # Called on the ROS spin thread; the work (RMF requests) needs that thread.
        threading.Thread(target=self._handle, args=(cmd,), daemon=True).start()

    def _handle(self, cmd):
        kind = cmd.get('cmd')
        if kind == 'start':
            try:
                self.start(cmd.get('file', ''))
            except Exception as e:  # noqa: BLE001 - reported in the pane and the GUI
                self.log(f'[host] cannot start {cmd.get("file")}: {e}')
                self.rmf.event(f'mission not started: {e}')
                if not self.busy:       # show it in the GUI's stage
                    self.rmf.mission_pub.publish(self._String(data=json.dumps({
                        'name': os.path.basename(str(cmd.get('file'))), 'state': 'failed',
                        'error': str(e), 'alive': time.time(), 'robots': self.robots})))
        elif kind == 'abort':
            self.abort(cmd.get('reason') or 'STOP')

    def start(self, file):
        from . import stack
        from .primitives import Fleet
        file = stack.path(file)
        with self.lock:
            if self.busy:
                raise MissionError(f'mission {self.run.name} is still running')
            site = Site.load(self.site_path)        # re-read: edits apply without restart
            mission = _load_checked(file, site)
            fleet = Fleet(site, robots=self.robots, client=self.rmf, log=self.log,
                          console=False)
            self.run = MissionRun(fleet, mission, file).start()

    def abort(self, reason):
        run = self.run
        if run is not None and not run.done.is_set():
            run.abort(reason)

    def heartbeat(self):
        run = self.run
        self.pub.publish(self._String(data=json.dumps({
            'alive': time.time(), 'busy': self.busy, 'pid': os.getpid(),
            'site': self.site_path, 'robots': self.robots,
            'mission': run.name if run else None})))


def host_main(site_path, robots):
    """`m20 mission-host`: the tmux "mission" pane. Ctrl-C aborts the running mission
    (robots stop, standing); Ctrl-C with no mission running exits."""
    import signal
    from .rmf_client import RmfClient
    site = Site.load(site_path)
    robots = robots or site.robot_ids()
    client = RmfClient(fleet=site.fleet['name'], node_name='m20_mission_host')

    def _term(*_):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, _term)
    host = MissionHost(site_path, robots, client)
    try:
        host.listen()
    except MissionError as e:
        client.close()
        sys.exit(f'[host] {e}')
    print(f'[host] mission host ready: robots {robots}, site {site_path}\n'
          '[host] start missions from the GUI. Ctrl-C here: abort the running mission '
          '(robots stop, standing); Ctrl-C when idle: quit.', flush=True)
    try:
        while True:
            try:
                while True:
                    host.heartbeat()
                    time.sleep(1.0)
            except KeyboardInterrupt:
                if not host.busy:
                    print('\n[host] exiting', flush=True)
                    break
                print('\n[host] Ctrl-C: aborting the mission, stopping robots', flush=True)
                host.abort('Ctrl-C in the mission pane')
    finally:
        if host.busy:
            host.abort('mission host exiting')
        time.sleep(0.3)
        client.close()


if __name__ == '__main__':
    main()
