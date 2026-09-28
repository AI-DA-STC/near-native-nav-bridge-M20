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
    - sleep: 5                            plain delay

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

CONTROL = {'parallel', 'repeat', 'log', 'sleep'}
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
                kwargs = self._fit_robots(name, kwargs)
                if kwargs is None:
                    continue
                self.log(f'{prefix}[mission] step: {name} {kwargs}')
                fn(**kwargs)


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
                    if key in args and args[key] not in table:
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
    fleet._say(f'mission {mission.get("name", a.mission)} start, robots {fleet.robots}')
    try:
        Runner(fleet).run_steps(mission['steps'])
        fleet._say('mission complete')
    except KeyboardInterrupt:
        fleet._say('mission aborted by operator: stopping all robots')
        fleet.stop()
    finally:
        fleet.rmf.close()


if __name__ == '__main__':
    main()
