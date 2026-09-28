"""Unit tests that need neither ROS nor RMF running (pytest rmf/m20_rmf/test)."""

import json
import os
import socket
import threading
import time

import pytest

from m20_rmf import protocol
from m20_rmf.mission import Runner, check
from m20_rmf.robot_client import M20Client, NavState
from m20_rmf.sitefile import Site, SiteError

HERE = os.path.dirname(__file__)
SIM_SITE = os.path.join(HERE, '..', 'sites', 'sim_lab.yaml')


# ---------------------------------------------------------------- protocol
def test_header_matches_cpp_bridge():
    pkt = protocol.encode(protocol.heartbeat(), 0x1234)
    body = pkt[16:]
    assert pkt[:4] == bytes([0xEB, 0x91, 0xEB, 0x90])
    assert pkt[4] | (pkt[5] << 8) == len(body)
    assert pkt[6:8] == bytes([0x34, 0x12])
    assert pkt[8] == 0x01
    assert json.loads(body)['PatrolDevice']['Type'] == 100


def test_nav_goal_fields():
    d = protocol.nav_goal(3, 1.5, -2.0, 0.5)['PatrolDevice']
    assert (d['Type'], d['Command']) == (1003, 1)
    it = d['Items']
    assert (it['Value'], it['PosX'], it['PosY'], it['AngleYaw']) == (3, 1.5, -2.0, 0.5)
    assert it['Gait'] == 12290 and it['NavMode'] == 1


def test_response_parsing_items_and_top_level():
    r = protocol.Response({'PatrolDevice': {'Type': 1007, 'Command': 1,
                                            'Items': {'Value': 2, 'Status': 4, 'ErrorCode': 0}}})
    assert r.is_nav_status and r.status == 4 and r.value == 2
    r = protocol.Response({'PatrolDevice': {'Type': 1003, 'Command': 1, 'ErrorCode': 0xA341}})
    assert r.is_nav_ack and r.error == 0xA341
    assert protocol.Response('garbage').type is None
    assert protocol.decode(b'short') is None


def test_status_stream_real_packets():
    # Captured from robot 834 (fw PRO) on 2026-09-28.
    loc = protocol.Response({'PatrolDevice': {'Type': 1002, 'Command': 7, 'Items': {
        'NavStatus': {'Value': 0, 'Status': 0, 'ErrorCode': 0},
        'LocationStatus': {'Location': 1, 'PosX': 8.2023, 'PosY': -2.9515, 'Yaw': 1.4726}}}})
    assert loc.status_kind == 'location'
    bat = protocol.Response({'PatrolDevice': {'Type': 1002, 'Command': 5, 'Items': {
        'BatteryList': [{'BatteryLevel': 93}, {'BatteryLevel': 90}]}}})
    assert bat.status_kind == 'battery'


def test_udp_pose_fallback_and_odom_priority():
    c = M20Client('t', '127.0.0.1', 9, heartbeat_period=10)
    c._on_status('location', protocol.Response({'PatrolDevice': {'Type': 1002, 'Command': 7,
        'Items': {'LocationStatus': {'Location': 1, 'PosX': 1.0, 'PosY': 2.0, 'Yaw': 0.5}}}}))
    assert c.pose == (1.0, 2.0, 0.5) and c.pose_source == 'udp' and c.localized
    c.update_pose(3.0, 4.0, 0.0)                              # odom arrives: wins
    c._on_status('location', protocol.Response({'PatrolDevice': {'Type': 1002, 'Command': 7,
        'Items': {'LocationStatus': {'Location': 1, 'PosX': 9.0, 'PosY': 9.0, 'Yaw': 0}}}}))
    assert c.pose == (3.0, 4.0, 0.0) and c.pose_source == 'odom'
    c._on_status('battery', protocol.Response({'PatrolDevice': {'Type': 1002, 'Command': 5,
        'Items': {'BatteryList': [{'BatteryLevel': 93}, {'BatteryLevel': 90}]}}}))
    assert abs(c.battery - 0.915) < 1e-9
    c._on_status('basic', protocol.Response({'PatrolDevice': {'Type': 1002, 'Command': 6,
        'Items': {'BasicStatus': {'Sleep': 1}}}}))
    assert c.asleep is True
    c.close()


# -------------------------------------------------------------------- site
def test_sim_site_compiles():
    s = Site.load(SIM_SITE)
    g = s.nav_graph()
    verts = g['levels']['L1']['vertices']
    names = [v[2]['name'] for v in verts]
    assert set(names) == set(s.places)
    chargers = {v[2]['name'] for v in verts if v[2].get('is_charger')}
    assert chargers == {'home_741', 'home_665', 'home_834'}
    cfg = s.fleet_config()['rmf_fleet']
    assert set(cfg['robots']) == {'741', '665', '834'}
    assert 'explore' in cfg['actions'] and 'inspect' in cfg['actions']
    assert s.warnings() == []


def _site(**over):
    d = {'places': {'a': [0, 0, 0], 'b': [2, 0, 0]}, 'lanes': [['a', 'b']],
         'robots': {'1': {'ip': '127.0.0.1', 'home': 'a'}}}
    d.update(over)
    return d


def test_lanes_bidirectional_and_oneway():
    s = Site(_site(lanes=[['a', 'b']]))
    assert {(a, b) for a, b, _ in s.lanes} == {('a', 'b'), ('b', 'a')}
    s = Site(_site(lanes=[{'path': ['a', 'b'], 'oneway': True}]))
    assert [(a, b) for a, b, _ in s.lanes] == [('a', 'b')]


@pytest.mark.parametrize('over,msg', [
    ({'lanes': [['a', 'zz']]}, 'unknown place'),
    ({'routes': {'r': ['a', 'nope']}}, 'unknown place'),
    ({'robots': {'1': {'home': 'a'}}}, 'missing ip'),
    ({'robots': {'1': {'ip': 'x'}}}, 'missing home'),
    ({'places': {'a': [0, 0], 'b': [1, 0], 'c': [5, 5]}}, 'no lanes'),
    ({'zones': {'z': {'entry': 'a'}}}, 'needs tracks or poses'),
    ({'formations': {'f': {'slots': ['a'], 'assign': 'random'}}}, 'nearest|fixed'),
])
def test_validation_errors(over, msg):
    with pytest.raises(SiteError, match=msg):
        Site(_site(**over))


def test_spacing_warning():
    s = Site(_site(places={'a': [0, 0, 0], 'b': [0.8, 0, 0]},
                   formations={'f': {'slots': ['a', 'b']}}))
    assert any('below RMF separation' in w for w in s.warnings())


def test_resolve_pose():
    s = Site(_site())
    assert s.resolve_pose('b') == [2.0, 0.0, 0.0]
    assert s.resolve_pose([1, 2]) == [1.0, 2.0, 0.0]
    assert s.nearest_place(1.9, 0.1) == 'b'


# ------------------------------------------------------------------ client
class FakeRobot:
    """Minimal UDP responder: records commands, answers goals with a chosen error."""

    def __init__(self, goal_errors=()):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(('127.0.0.1', 0))
        self.sock.settimeout(0.1)
        self.port = self.sock.getsockname()[1]
        self.goal_errors = list(goal_errors)
        self.received = []
        self.running = True
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while self.running:
            try:
                data, peer = self.sock.recvfrom(4096)
            except socket.timeout:
                continue
            d = protocol.decode(data)['PatrolDevice']
            self.received.append((d['Type'], d['Command']))
            if d['Type'] == 1003:
                err = self.goal_errors.pop(0) if self.goal_errors else 0
                self.sock.sendto(protocol.encode({'PatrolDevice': {
                    'Type': 1003, 'Command': 1, 'Items': {'ErrorCode': err}}}, 0), peer)

    def types(self):
        return [t for t, _ in self.received]


def _wait(pred, timeout=5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.05)
    return False


def test_arrival_requires_settling():
    bot = FakeRobot()
    c = M20Client('t', '127.0.0.1', bot.port, settle_time=0.4, heartbeat_period=10)
    c.update_pose(0, 0, 0)
    c.go_to(1.0, 0.0, 0.0)
    assert _wait(lambda: 1003 in bot.types())
    c.update_pose(0.95, 0.0, 0.0)          # inside tolerance but just moved
    assert c.nav_state() == NavState.NAVIGATING
    time.sleep(0.5)
    c.update_pose(0.95, 0.0, 0.0)          # no motion for > settle_time
    assert c.nav_state() == NavState.ARRIVED
    c.close()


def test_busy_error_triggers_cancel_then_resend():
    bot = FakeRobot(goal_errors=[0xA341])
    c = M20Client('t', '127.0.0.1', bot.port, heartbeat_period=10)
    c.update_pose(0, 0, 0)
    c.go_to(3.0, 0.0, 0.0)
    assert _wait(lambda: c.goal is not None and c.goal.error == 0xA341)
    assert c.nav_state() == NavState.NAVIGATING
    assert _wait(lambda: bot.types().count(1003) >= 2)
    t = bot.types()
    assert 1004 in t[t.index(1003) + 1:], 'cancel must precede the resend'
    c.close()


def test_stall_fails_after_max_resends():
    bot = FakeRobot()
    c = M20Client('t', '127.0.0.1', bot.port, stall_timeout=0.1, max_resends=1,
                  heartbeat_period=10)
    c.update_pose(0, 0, 0)
    c.go_to(5.0, 0.0, 0.0)
    time.sleep(0.2)
    assert c.nav_state() == NavState.NAVIGATING   # first stall -> resend
    time.sleep(0.2)
    assert c.nav_state() == NavState.FAILED
    c.close()


def test_fatal_error_fails_immediately():
    bot = FakeRobot(goal_errors=[0xA302])        # battery too low
    c = M20Client('t', '127.0.0.1', bot.port, heartbeat_period=10)
    c.update_pose(0, 0, 0)
    c.go_to(5.0, 0.0, 0.0)
    assert _wait(lambda: c.nav_state() == NavState.FAILED)
    c.close()


# ----------------------------------------------------------------- mission
def test_mission_check_catches_bad_names():
    s = Site.load(SIM_SITE)
    m = {'steps': [{'form_up': {'formation': 'nope'}},
                   {'parallel': [{'inspect': {'target': 'box1', 'robot': '999'}}]},
                   {'patrol': {}}]}
    problems = check(m, s)
    assert any('unknown formation' in p for p in problems)
    assert any('unknown robot' in p for p in problems)
    ok = {'steps': [{'form_up': {'formation': 'muster'}}, {'explore': {'zone': 'new_area'}}]}
    assert check(ok, s) == []


def test_bundled_missions_are_valid():
    from m20_rmf.mission import load
    sdir, mdir = os.path.join(HERE, '..', 'sites'), os.path.join(HERE, '..', 'missions')
    sites = [Site.load(os.path.join(sdir, f)) for f in os.listdir(sdir) if f.endswith('.yaml')]
    for f in os.listdir(mdir):
        if f.endswith('.yaml'):
            m = load(os.path.join(mdir, f))
            assert any(check(m, s) == [] for s in sites), f'{f} fits no bundled site'


class _FakeFleet:
    def __init__(self, robots):
        self.robots = robots
        self.calls = []

    def _say(self, text):
        pass

    def inspect(self, **kw):
        self.calls.append(('inspect', kw))

    def hold(self, **kw):
        self.calls.append(('hold', kw))


def test_runner_fits_missing_robots():
    f = _FakeFleet(['834'])
    Runner(f, log=lambda *_: None).run_steps([
        {'inspect': {'target': 'box1', 'robot': '741'}},      # falls back to 834
        {'hold': {'robots': ['741', '665'], 'seconds': 1}},   # nobody active: skipped
        {'hold': {'robots': ['741', '834'], 'seconds': 1}},   # trimmed to 834
    ])
    assert f.calls == [('inspect', {'target': 'box1', 'robot': '834'}),
                       ('hold', {'robots': ['834'], 'seconds': 1})]


# ------------------------------------------------------------- assignment
def test_nearest_slot_assignment():
    from m20_rmf.primitives import Fleet

    class FakeRmf:
        robot_status = {'741': {'pose': [-1.0, 0.2, 0]}, '665': {'pose': [-1.0, -2.2, 0]},
                        '834': {'pose': [-1.0, -1.0, 0]}}

        def event(self, *a, **k):
            pass
    f = Fleet(SIM_SITE, client=FakeRmf(), log=lambda *_: None)
    slots = f.assign_slots('muster', ['741', '665', '834'])
    assert slots == {'741': 'muster_3', '665': 'muster_1', '834': 'muster_2'}
