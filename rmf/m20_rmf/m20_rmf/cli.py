"""`m20` — operator CLI over the mission primitives.

Site file: --site, $M20_SITE, or `site:` in m20_stack.yaml. Active robots: --robots,
$M20_ROBOTS, or `robots:` in m20_stack.yaml (comma
list), default all robots in the site.

  Setup / localization
    m20 pose 834                           current pose from /ODOM_relayed_834
    m20 relocalize 834 home_834            set SLAM pose at a place (or: 834 x y yaw)
    m20 graph                              write nav graph + fleet config, print summary
    m20 map-save 834 [name]                save the robot's SLAM map (maps/<name>.yaml);
                                           then add `map: ../maps/<name>.yaml` to the site

  Edit the site file (comments kept; shows a diff; checked before writing)
    m20 site new sites/lab_b.yaml --from 834
                                           start a new site: 834 with its home at its
                                           current pose (or --at x y yaw); then point
                                           site: in m20_stack.yaml at it
    m20 place ls                           places, their lanes and what uses them
    m20 place set scan_1 --from 834 --link fwd_2
                                           add/move a place to 834's current pose, with
                                           a lane to fwd_2 (a new place needs --link)
    m20 place set scan_1 1.5 -6.6 [yaw]    ... or at coordinates (yaw in rad)
    m20 place rm scan_1                    remove it and its lanes (refused while a
                                           route/formation/zone/target/home uses it)
    m20 lane add a b [c ...]               lanes a<->b(<->c), two-way
    m20 lane rm a b                        remove the lane between a and b
    m20 route set loop a b c               patrol route (create or replace)
    m20 route rm loop
    (each takes --dry-run; --force writes even if a mission would break.
     RMF uses the new graph after: scripts/m20_stack.sh restart rmf)

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
                                           RMF task cancel; ends the running mission.
                                           Use this.
    m20 estop --drop [834|all]             vendor e-stop: the robot DROPS to the ground
    m20 trigger start                      release wait_for_event / wait_trigger
    m20 inspect-result <id|latest> '{"verdict": "empty"}'
    m20 status                             robots + recent tasks
    m20 events                             follow /m20/events
    m20 mission missions/visitor_demo.yaml [--check]    run here; Ctrl-C aborts + stops
    m20 mission-host                       run missions the GUI starts (tmux "mission"
                                           pane); Ctrl-C aborts + stops, again quits
"""

import argparse
import json
import math
import os
import sys
import tempfile
import time

import yaml

from . import stack
from .sitefile import Site


def _site_path(a):
    return a.site or os.environ.get('M20_SITE') or stack.load().get('site')


def _site(a):
    path = _site_path(a)
    if not path:
        sys.exit('no site: pass --site, set M20_SITE, or set site: in m20_stack.yaml')
    if not os.path.exists(path):
        sys.exit(f'no site file {path}: start one with  m20 site new {path} --from <robot>')
    return Site.load(path)


def _robots(a):
    r = a.robots or os.environ.get('M20_ROBOTS', '')
    return [x for x in r.split(',') if x] or stack.robots_for(_site_path(a))


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


# ------------------------------------------------------------------ site edits
def _missions_near(site_path):
    import glob
    d = os.path.join(os.path.dirname(os.path.abspath(site_path)), '..', 'missions')
    return sorted(glob.glob(os.path.join(d, '*.yaml')))


def _edit_site(a, change):
    """change(SiteText, old Site) edits the text and returns what it did. Shows the diff,
    checks the result (site + missions), then writes."""
    from . import siteedit
    path = _site_path(a)
    if not path:
        sys.exit('no site: pass --site, set M20_SITE, or set site: in m20_stack.yaml')
    if not os.path.exists(path):
        sys.exit(f'no site file {path}: start one with  m20 site new {path} --from <robot>')
    with open(path) as f:
        old_text = f.read()
    old_site = Site.load(path)
    ed = siteedit.SiteText(old_text)
    try:
        done = change(ed, old_site)
        site, broken = siteedit.check_text(ed.text(), path, _missions_near(path), old_site)
    except siteedit.EditError as e:
        sys.exit(f'not changed: {e}')
    if broken and not a.force:
        sys.exit('not changed: this breaks missions:\n  ' + '\n  '.join(broken) +
                 '\n(fix them, or --force to change the site anyway)')
    print(siteedit.diff(old_text, ed.text(), path), end='')
    if a.dry_run:
        print('(dry run: nothing written)')
        return
    with open(path, 'w') as f:
        f.write(ed.text())
    print(done)
    for b in broken:
        print(f'WARNING: {b}')
    for w in site.warnings():
        print(f'WARNING: {w}')
    print('The GUI/RViz map shows it now. RMF routes with it after: '
          'scripts/m20_stack.sh restart rmf  (on the host; robots must be idle)')


def cmd_site_new(a):
    from . import siteedit
    if os.path.exists(a.path):
        sys.exit(f'{a.path} exists: edit it with m20 place/lane/route, or pick another name')
    if a.robot:
        rid, pose = a.robot, _read_pose(a.robot)
        note = f'home = {rid} pose, {time.strftime("%F %T %Z")}'
    elif a.at and a.id:
        rid, pose, note = a.id, list(a.at), ''
    else:
        sys.exit('where is its home? --from <robot> (its current pose), or --id <robot> --at x y yaw')
    ip, port = a.ip, None
    if not ip:          # the robot's address from the current site
        cur = _site_path(a)
        r = Site.load(cur).robots.get(str(rid)) if cur and os.path.exists(cur) else None
        if r is None:
            sys.exit(f'robot {rid} is not in the current site: pass --ip <address>')
        ip, port = r['ip'], r.get('port')
    text = siteedit.new_site(rid, ip, port, pose, note)
    Site(yaml.safe_load(text), a.path)          # it must load before it is written
    os.makedirs(os.path.dirname(os.path.abspath(a.path)), exist_ok=True)
    with open(a.path, 'w') as f:
        f.write(text)
    cfg = stack.find()
    rel = os.path.relpath(os.path.abspath(a.path), os.path.dirname(os.path.abspath(cfg))) \
        if cfg and os.path.exists(cfg) else a.path
    print(f'created {a.path}: robot {rid} ({ip}), home_{rid} at '
          f'({pose[0]:.3f}, {pose[1]:.3f}, {pose[2]:.3f})\n'
          f'next: set  site: {rel}  in m20_stack.yaml, restart the stack '
          f'(down + up), then add places:\n'
          f'  m20 place set <name> --from {rid} --link home_{rid}')


def cmd_place_ls(a):
    from . import siteedit
    site = _site(a)
    print(f'{site.path}')
    for n, (x, y, yaw) in site.places.items():
        uses = siteedit.place_uses(site, n)
        print(f'  {n:<16} x {x:8.3f}  y {y:8.3f}  yaw {math.degrees(yaw):7.1f}°   '
              f'lanes: {", ".join(siteedit.neighbours(site, n)) or "-"}'
              + (f'   used by: {", ".join(uses)}' if uses else ''))
    for k, r in site.routes.items():
        print(f'  route {k}: {" -> ".join(r)}')


def cmd_place_set(a):
    if a.robot:
        pose = _read_pose(a.robot)
        how = f'{a.robot} pose, {time.strftime("%F %T %Z")}'
    elif len(a.coords) in (2, 3):
        pose = list(a.coords)
        how = ''
    else:
        sys.exit('where? --from <robot> (its current pose), or x y [yaw]')

    def change(ed, site):
        new = a.name not in site.places
        if len(pose) == 2:
            pose.append(0.0 if new else site.places[a.name][2])
        if new and not a.link:
            from .siteedit import EditError
            raise EditError(f'{a.name} is a new place: give --link <place> so RMF can reach it')
        ed.set_place(a.name, pose, how)
        for p in a.link:
            if not ed.lane_exists(a.name, p):
                ed.add_lane([a.name, p])
        return (f'{"added" if new else "moved"} {a.name} at ({pose[0]:.3f}, {pose[1]:.3f}, '
                f'{pose[2]:.3f})' + (f', lanes to {", ".join(a.link)}' if a.link else ''))
    _edit_site(a, change)


def cmd_place_rm(a):
    from .siteedit import EditError, neighbours, place_uses

    def change(ed, site):
        if a.name not in site.places:
            raise EditError(f'no place {a.name!r}')
        uses = place_uses(site, a.name)
        if uses:
            raise EditError(f'{a.name} is used by {", ".join(uses)}: change those first')
        ed.remove_place(a.name)
        return f'removed {a.name} and its lanes to {", ".join(neighbours(site, a.name)) or "-"}'
    _edit_site(a, change)


def cmd_lane_add(a):
    def change(ed, site):
        ed.add_lane(a.places)
        return f'lanes {" <-> ".join(a.places)} added'
    _edit_site(a, change)


def cmd_lane_rm(a):
    def change(ed, site):
        ed.remove_lane(a.a, a.b)
        return f'lane {a.a} <-> {a.b} removed'
    _edit_site(a, change)


def cmd_route_set(a):
    def change(ed, site):
        ed.set_route(a.name, a.places)
        return f'route {a.name}: {" -> ".join(a.places)}'
    _edit_site(a, change)


def cmd_route_rm(a):
    from .siteedit import EditError

    def change(ed, site):
        users = [k for k, r in site.robots.items() if r.get('route') == a.name]
        if users:
            raise EditError(f'robots {users} patrol {a.name} (robots.<id>.route): change that first')
        ed.remove_route(a.name)
        return f'route {a.name} removed'
    _edit_site(a, change)


def _run(a, fn):
    f = _fleet(a)
    try:
        return fn(f)
    except KeyboardInterrupt:
        print('interrupted: stopping the robots')
        f.stop(f.robots)
    finally:
        f.rmf.close()


def cmd_map_save(a):
    import rclpy
    import rclpy.node
    from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
    from nav_msgs.msg import OccupancyGrid
    from . import mapfile
    if not rclpy.ok():
        rclpy.init()
    node = rclpy.node.Node('m20_map_save')
    got = []
    node.create_subscription(OccupancyGrid, f'/GRID_MAP_relayed_{a.robot}', got.append,
                             QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE,
                                        durability=DurabilityPolicy.TRANSIENT_LOCAL))
    deadline = time.monotonic() + 20
    while not got and time.monotonic() < deadline:
        rclpy.spin_once(node, timeout_sec=0.2)
    node.destroy_node()
    if not got:
        sys.exit(f'no map on /GRID_MAP_relayed_{a.robot} within 20 s: is the robot relaying '
                 'its GRID_MAP (robot_relay odom/full) and the laptop bridge running?')
    g = got[-1]
    site_path = _site_path(a)
    out_dir = a.out or os.path.join(os.path.dirname(os.path.abspath(site_path or '.')), '..', 'maps')
    os.makedirs(out_dir, exist_ok=True)
    name = a.name or f'map_{a.robot}_{time.strftime("%Y%m%d")}'
    path = os.path.normpath(os.path.join(out_dir, name + '.yaml'))
    o = g.info.origin.position
    mapfile.save(path, g.info.width, g.info.height, g.info.resolution, [o.x, o.y, 0.0],
                 list(g.data))
    print(f'saved {path} ({g.info.width}x{g.info.height} @ {g.info.resolution:.2f} m)')
    if site_path:
        rel = os.path.relpath(path, os.path.dirname(os.path.abspath(site_path)))
        print(f'add to {site_path}:  map: {rel}')


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
    add('relocalize', cmd_relocalize, rob, (('where',), {'nargs': '+'}))
    add('graph', cmd_graph, (('--out',), {}))
    add('map-save', cmd_map_save, rob, (('name',), {'nargs': '?'}), (('--out',), {}))
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
                                                    else a.which.split(','), source='m20 stop')),
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
    add('mission-host', lambda a: _mission_host(a))

    def group(name, help_text, actions):
        g = sub.add_parser(name, help=help_text).add_subparsers(dest='action', required=True)
        for act, fn, specs in actions:
            sp = g.add_parser(act)
            for flags, kw in specs:
                sp.add_argument(*flags, **kw)
            if act != 'ls':
                sp.add_argument('--dry-run', action='store_true', help='show the diff only')
                sp.add_argument('--force', action='store_true',
                                help='write even if a mission would break')
            sp.set_defaults(fn=fn)
    name = (('name',), {})
    g = sub.add_parser('site', help='start a new site file').add_subparsers(dest='action', required=True)
    sp = g.add_parser('new')
    sp.add_argument('path')
    sp.add_argument('--from', dest='robot', help='the robot whose current pose is its home')
    sp.add_argument('--id', help='robot id, with --at')
    sp.add_argument('--at', nargs=3, type=float, metavar=('X', 'Y', 'YAW'))
    sp.add_argument('--ip', help='robot address (default: from the current site)')
    sp.set_defaults(fn=cmd_site_new)
    group('place', 'list / add / move / remove places', [
        ('ls', cmd_place_ls, []),
        ('set', cmd_place_set, [name, (('coords',), {'nargs': '*', 'type': float}),
                                (('--from',), {'dest': 'robot', 'help': 'use this robot\'s pose'}),
                                (('--link',), {'action': 'append', 'default': [],
                                               'help': 'also add a lane to this place'})]),
        ('rm', cmd_place_rm, [name]),
    ])
    group('lane', 'add / remove lanes', [
        ('add', cmd_lane_add, [(('places',), {'nargs': '+'})]),
        ('rm', cmd_lane_rm, [(('a',), {}), (('b',), {})]),
    ])
    group('route', 'set / remove patrol routes', [
        ('set', cmd_route_set, [name, (('places',), {'nargs': '+'})]),
        ('rm', cmd_route_rm, [name]),
    ])
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


def _mission_host(a):
    from . import mission
    site = _site_path(a)
    if not site:
        sys.exit('no site: pass --site, set M20_SITE, or set site: in m20_stack.yaml')
    mission.host_main(site, _robots(a))


if __name__ == '__main__':
    main()
