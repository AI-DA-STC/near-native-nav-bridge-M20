"""Tests for the fleet view (modes), RViz markers and mission signals; no ROS graph needed."""

import os

import pytest

from m20_rmf import view
from m20_rmf.mission import MissionError, Runner, check, load
from m20_rmf.rmf_client import parse_trigger
from m20_rmf.sitefile import Site

HERE = os.path.dirname(__file__)
SIM_SITE = os.path.join(HERE, '..', 'sites', 'sim_lab.yaml')


def status(rid='834', **kw):
    s = {'robot': rid, 'pose': [0.0, 0.0, 0.0], 'pose_age': 0.1, 'udp_link': True,
         'height': 0.56, 'asleep': False, 'battery': 0.8, 'goal': None, 'action': None}
    s.update(kw)
    return s


def task(label, rid='834', st='underway'):
    return {'booking': {'id': 't', 'labels': [label]}, 'status': st,
            'assigned_to': {'group': 'm20', 'name': rid}}


@pytest.mark.parametrize('label,mode,detail', [
    ('patrol:patrol_834', 'PATROL', 'patrol_834'),
    ('form_up:muster', 'REGROUP', 'muster'),
    ('explore:new_area', 'EXPLORE', 'new_area'),
    ('inspect:box1', 'INVESTIGATE', 'box1'),
    ('return_home', 'RETURN', ''),
    ('go_to:door_a', 'MOVE', 'door_a'),
    ('action:waypoints', 'MOVE', 'path'),
    ('action:dwell', 'HOLD', ''),
    ('', 'MOVE', ''),
])
def test_mode_from_label(label, mode, detail):
    assert view.mode_from_label(label) == (mode, detail)


def test_robot_state_precedence():
    tasks = {'a': task('patrol:r')}
    v = view.fleet_view([status()], tasks, {}, set(), [], {})
    assert v['robots'][0]['mode'] == 'PATROL'
    assert v['robots'][0]['color'] == view.MODES['PATROL']
    # offline beats everything
    v = view.fleet_view([status(pose=None)], tasks, {}, set(), [], {})
    assert v['robots'][0]['mode'] == 'OFFLINE'
    # no task: stopped, then sitting, then idle
    assert view.robot_view(status(), None, stopped=True)['mode'] == 'STOPPED'
    assert view.robot_view(status(height=0.08), None)['mode'] == 'SITTING'
    assert view.robot_view(status(), None)['mode'] == 'IDLE'
    # a task while sitting: its mode plus one warning
    r = view.robot_view(status(height=0.08), ('patrol:r', 't'))
    assert r['mode'] == 'PATROL' and r['warning'] == 'sitting'


def test_finished_tasks_are_ignored_and_underway_wins():
    tasks = {'old': task('patrol:r', st='completed'), 'q': task('go_to:a', st='standby'),
             'now': task('explore:z')}
    assert view.running_tasks(tasks) == {'834': ('explore:z', 'now')}


def test_awaiting_verdict_detail():
    r = view.robot_view(status(action={'category': 'inspect', 'awaiting_verdict': True}),
                        ('inspect:box1', 't'))
    assert r['mode'] == 'INVESTIGATE' and r['detail'] == 'box1 · awaiting verdict'


def test_markers_cover_site_and_robots():
    from m20_rmf.viz import Markers
    site = Site.load(SIM_SITE)
    mk = Markers(site)
    ns = {m.ns for m in mk.site_markers()}
    assert {'site/lanes', 'site/places', 'site/formations', 'site/zones', 'site/targets'} <= ns
    v = view.fleet_view([status(goal=[1.0, 1.0, 0.0])], {'a': task('inspect:box1')}, {}, set(),
                        [], {'r1': {'robot': '834', 'target': 'box1'}})
    rm = mk.robot_markers(v, now=1.0)
    kinds = {m.ns for m in rm}
    assert {'robots/body', 'robots/label', 'robots/plan', 'robots/focus'} <= kinds
    label = next(m for m in rm if m.ns == 'robots/label')
    assert label.text == '834\nINVESTIGATE'


def test_parse_trigger():
    assert parse_trigger('go') == {'event': 'go'}
    assert parse_trigger('{"event": "suspicious", "target": "box1"}') == \
        {'event': 'suspicious', 'target': 'box1'}


class _Fleet:
    robots = ['834']

    def __init__(self, payload):
        self.payload, self.calls, self.phases = payload, [], []

    def _say(self, text):
        pass

    def publish_mission(self, **kw):
        if 'phase' in kw:
            self.phases.append(kw['phase'])
        if 'used' in kw:
            self.used = kw['used']

    def wait_trigger(self, **kw):
        return self.payload

    def inspect(self, **kw):
        self.calls.append(kw)


def test_signal_data_fills_later_steps():
    f = _Fleet({'event': 'suspicious', 'target': 'box1'})
    Runner(f, log=lambda *_: None).run_steps([
        {'phase': 'Patrolling'},
        {'wait_trigger': {'event': 'suspicious'}},
        {'inspect': {'target': '${suspicious.target}', 'robot': '834'}},
    ])
    assert f.phases == ['Patrolling']
    assert f.calls == [{'target': 'box1', 'robot': '834'}]
    assert f.used == ['suspicious']           # the GUI stops offering it


def test_map_file_round_trip(tmp_path):
    from m20_rmf import mapfile
    data = [-1] * 6 + [0] * 6 + [100] * 6      # rows bottom -> top
    path = str(tmp_path / 'm.yaml')
    mapfile.save(path, 6, 3, 0.1, [-1.0, 2.0, 0.0], data)
    m = mapfile.load(path)
    assert (m['width'], m['height'], m['resolution']) == (6, 3, 0.1)
    assert m['origin'][:2] == [-1.0, 2.0] and m['data'] == data


def test_signal_missing_is_an_error():
    f = _Fleet(None)
    with pytest.raises(MissionError, match='no signal'):
        Runner(f, log=lambda *_: None).run_steps([
            {'inspect': {'target': '${suspicious.target}', 'robot': '834'}}])


def test_check_accepts_signal_placeholders():
    site = Site.load(SIM_SITE)
    m = {'steps': [{'inspect': {'target': '${suspicious.target}', 'robot': '834'}}]}
    assert check(m, site) == []
    demo = load(os.path.join(HERE, '..', 'missions', 'visitor_demo.yaml'))
    assert check(demo, site) == []
