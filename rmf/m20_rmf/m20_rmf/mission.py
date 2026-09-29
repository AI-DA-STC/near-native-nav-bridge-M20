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
    - repeat: {times: 3, steps: [...]}    loop
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

`robot` / `robots` may name robots that are not active in this run (e.g. a 3-robot
mission tested with one dog): missing robots are dropped from lists, and a single
`robot` falls back to the first active robot, with a notice. `--check` validates
every name against the site without touching RMF.
"""

import argparse
import sys
import threading
import time

import yaml

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
            name, args = _split(step)
            prefix = '  ' * depth
            if name == 'log':
                self.fleet._say(str(args))
            elif name == 'phase':
                self.fleet._say(str(args))
                self.fleet.publish_mission(phase=str(args))
            elif name == 'sleep':
                time.sleep(float(args))
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
                for n in range(int(args.get('times', 1))):
                    self.log(f'{prefix}[mission] repeat {n + 1}/{args.get("times", 1)}')
                    self.run_steps(args['steps'], depth + 1)
            else:
                fn = getattr(self.fleet, name, None)
                if fn is None or name.startswith('_'):
                    raise MissionError(f'unknown primitive {name!r}')
                kwargs = dict(args or {}) if isinstance(args, dict) else {}
                kwargs = self._fit_robots(name, self._resolve(kwargs))
                if kwargs is None:
                    continue
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
                for key in ROBOT_ARGS & args.keys():
                    v = args[key]
                    for r in (v if isinstance(v, list) else [v]):
                        if r not in (None, 'all') and str(r) not in site.robots:
                            problems.append(f'{name}: unknown robot {r!r}')
    walk(mission['steps'])
    return problems


def main(argv=None):
    import rclpy
    from . import domain_guard
    argv = list(argv or sys.argv)
    domain_guard.check(argv=argv)
    p = argparse.ArgumentParser(prog='m20_mission')
    p.add_argument('mission')
    p.add_argument('--site', required=True)
    p.add_argument('--robots', default='', help='comma list of active robots (default: all)')
    p.add_argument('--check', action='store_true', help='validate only')
    a = p.parse_args(rclpy.utilities.remove_ros_args(argv or sys.argv)[1:])
    site = Site.load(a.site)
    mission = load(a.mission)
    problems = check(mission, site)
    if problems:
        sys.exit('mission check failed:\n  ' + '\n  '.join(problems))
    if a.check:
        print(f'{a.mission}: OK ({len(mission["steps"])} steps)')
        return
    import signal
    from .primitives import Fleet

    # rclpy swallows SIGTERM into a context shutdown while the main thread may be
    # blocked in a wait; turn it into the same clean abort as Ctrl-C.
    def _term(*_):
        raise KeyboardInterrupt
    robots = [r for r in a.robots.split(',') if r] or None
    fleet = Fleet(site, robots=robots)
    signal.signal(signal.SIGTERM, _term)   # after rclpy.init, which installs its own
    name = mission.get('name', a.mission)
    fleet._say(f'mission {name} start, robots {fleet.robots}')
    fleet.rmf.on_trigger = fleet.publish_mission        # show queued signals in the GUI
    fleet.publish_mission(name=name, file=a.mission, state='running', started=time.time(),
                          phase='', waiting=None, signals=mission.get('signals') or [],
                          description=mission.get('description', ''))
    try:
        Runner(fleet).run_steps(mission['steps'])
        fleet._say('mission complete')
        fleet.publish_mission(state='complete', waiting=None, ended=time.time())
    except KeyboardInterrupt:
        fleet.aborted.set()
        fleet._say('mission aborted by operator: stopping all robots')
        fleet.publish_mission(state='aborted', waiting=None, ended=time.time())
        fleet.stop()
    except Exception as e:  # noqa: BLE001 - shown in the GUI, then re-raised
        fleet.publish_mission(state='failed', error=str(e), waiting=None, ended=time.time())
        raise
    finally:
        time.sleep(0.3)     # let the last mission state go out
        fleet.rmf.close()


if __name__ == '__main__':
    main()
