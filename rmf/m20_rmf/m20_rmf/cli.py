"""`m20` — operator CLI over the mission primitives.

Site file: --site, $M20_SITE, or `site:` in m20_stack.yaml. Active robots: --robots,
$M20_ROBOTS, or `robots:` in m20_stack.yaml (comma
list), default all robots in the site.

  Setup / localization
    m20 pose 834                           current pose from /ODOM_relayed_834
    m20 capture 834 muster_1               record current pose as a place (appends to
                                           <site>.captures.yaml, ready to paste)
    m20 relocalize 834 home_834            set SLAM pose at a place (or: 834 x y yaw)
    m20 graph                              write nav graph + fleet config, print summary

  Motion (each preempts the robot's current task unless --queue)
    m20 go 834 door_a [--yaw 1.57]         go to a place
    m20 pose-goal 834 x y yaw              off-graph goal (goto_pose action)
    m20 patrol [834,741] [--route r] [--rounds n]
    m20 form-up muster
    m20 explore new_area
    m20 inspect box1 834
    m20 action 834 turn_to '{"yaw": 1.57}' [--at place]
    m20 home

  Control
    m20 cancel [834|all]                   cancel RMF tasks
    m20 stop [834|all]                     STOP where they stand (no drop): UDP cancel +
                                           RMF task cancel. Use this.
    m20 estop --drop [834|all]             vendor e-stop: the robot DROPS to the ground
    m20 trigger start                      release wait_for_event / wait_trigger
    m20 inspect-result <id|latest> '{"verdict": "empty"}'
    m20 status                             robots + recent tasks
    m20 events                             follow /m20/events
    m20 mission missions/visitor_demo.yaml [--check]
"""

import argparse
import json
import math
import os
import sys
import tempfile
import time

from . import stack
from .sitefile import Site


def _site_path(a):
    return a.site or os.environ.get('M20_SITE') or stack.load().get('site')


def _site(a):
    path = _site_path(a)
    if not path:
        sys.exit('no site: pass --site, set M20_SITE, or set site: in m20_stack.yaml')
    return Site.load(path)


def _robots(a):
    r = a.robots or os.environ.get('M20_ROBOTS', '')
    return [x for x in r.split(',') if x] or stack.load().get('robots') or None


def _fleet(a):
    from .primitives import Fleet
    return Fleet(_site(a), robots=_robots(a))


def _read_pose(robot, timeout=5.0):
    import rclpy
    import rclpy.node
    from rclpy.qos import QoSProfile, ReliabilityPolicy
    from nav_msgs.msg import Odometry
    if not rclpy.ok():
        rclpy.init()
    node = rclpy.node.Node('m20_pose_reader')
    got = []
    node.create_subscription(Odometry, f'/ODOM_relayed_{robot}', got.append,
                             QoSProfile(depth=5, reliability=ReliabilityPolicy.BEST_EFFORT))
    deadline = time.monotonic() + timeout
    while not got and time.monotonic() < deadline:
        rclpy.spin_once(node, timeout_sec=0.2)
    node.destroy_node()
    if not got:
        sys.exit(f'no message on /ODOM_relayed_{robot} within {timeout}s — relay running?')
    p = got[-1].pose.pose
    yaw = math.atan2(2 * (p.orientation.w * p.orientation.z + p.orientation.x * p.orientation.y),
                     1 - 2 * (p.orientation.y ** 2 + p.orientation.z ** 2))
    return [round(p.position.x, 4), round(p.position.y, 4), round(yaw, 4)]


def cmd_pose(a):
    print(json.dumps(_read_pose(a.robot)))


def cmd_capture(a):
    pose = _read_pose(a.robot)
    site_path = _site_path(a)
    out = a.out or (site_path + '.captures.yaml' if site_path else 'captures.yaml')
    line = f'  {a.name}: [{pose[0]}, {pose[1]}, {pose[2]}]   # robot {a.robot}, {time.strftime("%F %T")}\n'
    with open(out, 'a') as f:
        f.write(line)
    print(line.rstrip())
    print(f'(appended to {out}; paste under places:)')


def cmd_relocalize(a):
    f = _fleet(a)
    where = a.where[0] if len(a.where) == 1 else [float(v) for v in a.where]
    f.relocalize(a.robot, where)
    f.rmf.close()


def cmd_graph(a):
    site = _site(a)
    out = a.out or os.path.join(tempfile.gettempdir(), 'm20_rmf')
    os.makedirs(out, exist_ok=True)
    nav, cfg = os.path.join(out, 'nav_graph.yaml'), os.path.join(out, 'fleet_config.yaml')
    site.write(nav, cfg)
    for w in site.warnings():
        print(f'WARNING: {w}')
    print(f'places {len(site.places)}, lanes {len(site.lanes)}, routes {list(site.routes)}, '
          f'formations {list(site.formations)}, zones {list(site.zones)}, '
          f'targets {list(site.targets)}, robots {list(site.robots)}')
    print(f'wrote {nav}\n      {cfg}')


def _run(a, fn):
    f = _fleet(a)
    try:
        return fn(f)
    except KeyboardInterrupt:
        print('interrupted: stopping the robots')
        f.stop(f.robots)
    finally:
        f.rmf.close()


def cmd_status(a):
    f = _fleet(a)
    time.sleep(1.5)
    print('ROBOTS')
    for r, s in sorted(f.rmf.robot_status.items()):
        print(f'  {r}: {json.dumps(s)}')
    if not f.rmf.robot_status:
        print('  (no /m20/robot_status — is the fleet adapter running?)')
    print('TASKS (latest 15)')
    items = list(f.rmf.tasks.items())[-15:]
    for tid, st in items:
        who = (st.get('assigned_to') or {}).get('name', '?')
        print(f'  {tid}: {st.get("status")} [{who}] {st.get("category", "")}')
    f.rmf.close()


def cmd_events(a):
    import rclpy
    import rclpy.node
    from std_msgs.msg import String
    rclpy.init()
    node = rclpy.node.Node('m20_events_tail')

    def cb(msg):
        d = json.loads(msg.data)
        extra = {k: v for k, v in d.items() if k not in ('robot', 'text', 't')}
        print(f'{time.strftime("%H:%M:%S", time.localtime(d.get("t", time.time())))} '
              f'[{d.get("robot")}] {d.get("text")}{"  " + json.dumps(extra) if extra else ""}',
              flush=True)
    node.create_subscription(String, '/m20/events', cb, 50)
    node.create_subscription(String, '/m20/inspect/request',
                             lambda m: print(f'INSPECT REQUEST {m.data}', flush=True), 10)
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass


def cmd_inspect_result(a):
    from std_msgs.msg import String
    f = _fleet(a)
    body = json.loads(a.json) if a.json else {}
    body['id'] = a.id
    n = f.rmf.publish_once(f.rmf.inspect_result_pub, String(data=json.dumps(body)))
    print(f'inspect result sent to {n} listener(s)')
    f.rmf.close()


def main(argv=None):
    import rclpy
    from . import domain_guard
    argv = list(argv or sys.argv)
    domain_guard.check(argv=argv)
    argv = rclpy.utilities.remove_ros_args(argv)[1:]
    p = argparse.ArgumentParser(prog='m20', description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--site')
    p.add_argument('--robots', help='active robots, comma list')
    sub = p.add_subparsers(dest='cmd', required=True)

    def add(name, fn, *args):
        sp = sub.add_parser(name)
        for spec in args:
            flags, kw = spec
            sp.add_argument(*flags, **kw)
        sp.set_defaults(fn=fn)
        return sp

    rob = (('robot',), {})
    wait = (('--no-wait',), {'action': 'store_true'})
    queue = (('--queue',), {'action': 'store_true'})
    add('pose', cmd_pose, rob)
    add('capture', cmd_capture, rob, (('name',), {}), (('--out',), {}))
    add('relocalize', cmd_relocalize, rob, (('where',), {'nargs': '+'}))
    add('graph', cmd_graph, (('--out',), {}))
    add('go', lambda a: _run(a, lambda f: f.go_to(a.robot, a.place, yaw=a.yaw,
                                                   face='travel' if a.face_travel else 'place',
                                                   wait=not a.no_wait, queue=a.queue)),
        rob, (('place',), {}), (('--yaw',), {'type': float}),
        (('--face-travel',), {'action': 'store_true',
                              'help': 'end facing the arrival direction, not the place yaw'}),
        wait, queue)
    add('pose-goal', lambda a: _run(a, lambda f: f.go_to_pose(
        a.robot, [a.x, a.y, a.yaw], wait=not a.no_wait, queue=a.queue)),
        rob, (('x',), {'type': float}), (('y',), {'type': float}), (('yaw',), {'type': float}),
        wait, queue)
    add('patrol', lambda a: _run(a, lambda f: f.patrol(
        a.which.split(',') if a.which else None, route=a.route, rounds=a.rounds,
        wait=a.wait)),
        (('which',), {'nargs': '?'}), (('--route',), {}), (('--rounds',), {'type': int, 'default': 1000}),
        (('--wait',), {'action': 'store_true'}))
    add('form-up', lambda a: _run(a, lambda f: f.form_up(a.formation, wait=not a.no_wait)),
        (('formation',), {}), wait)
    add('explore', lambda a: _run(a, lambda f: f.explore(a.zone, wait=not a.no_wait)),
        (('zone',), {}), wait)
    add('inspect', lambda a: _run(a, lambda f: f.inspect(a.target, a.robot, wait=not a.no_wait)),
        (('target',), {}), rob, wait)
    add('action', lambda a: _run(a, lambda f: f.action(
        a.robot, a.category, json.loads(a.json or '{}'), at=a.at, wait=not a.no_wait,
        queue=a.queue)),
        rob, (('category',), {}), (('json',), {'nargs': '?'}), (('--at',), {}), wait, queue)
    add('home', lambda a: _run(a, lambda f: f.return_home(wait=not a.no_wait)), wait)
    add('cancel', lambda a: _run(a, lambda f: f.cancel(None if a.which in (None, 'all')
                                                        else a.which.split(','))),
        (('which',), {'nargs': '?'}))
    add('stop', lambda a: _run(a, lambda f: f.stop(None if a.which in (None, 'all')
                                                    else a.which.split(','))),
        (('which',), {'nargs': '?'}))
    add('estop', lambda a: _run(a, lambda f: f.estop(None if a.which in (None, 'all')
                                                      else a.which.split(','), drop=a.drop)),
        (('which',), {'nargs': '?'}),
        (('--drop',), {'action': 'store_true',
                       'help': 'required: acknowledges the robot will drop'}))
    add('trigger', lambda a: _run(a, lambda f: f.trigger(a.event)),
        (('event',), {'nargs': '?', 'default': 'go'}))
    add('inspect-result', cmd_inspect_result, (('id',), {}), (('json',), {'nargs': '?'}))
    add('status', cmd_status)
    add('events', cmd_events)
    sp = add('mission', None, (('file',), {}), (('--check',), {'action': 'store_true'}))
    sp.set_defaults(fn=lambda a: _mission(a))
    a = p.parse_args(argv)
    a.fn(a)


def _mission(a):
    from . import mission
    args = ['m20_mission', a.file, '--site', _site_path(a) or '']
    r = ','.join(_robots(a) or [])
    if r:
        args += ['--robots', r]
    if a.check:
        args.append('--check')
    mission.main(args)


if __name__ == '__main__':
    main()
