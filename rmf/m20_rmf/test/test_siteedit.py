"""Site editing keeps the file's comments, changes only what it must, and refuses edits
that would leave an invalid site."""

import os

import pytest
import yaml

from m20_rmf.siteedit import EditError, SiteText, check_text, place_uses
from m20_rmf.sitefile import Site

HERE = os.path.dirname(__file__)
CORRIDOR = os.path.join(HERE, '..', 'sites', 'lab_834_corridor.yaml')
SIM = os.path.join(HERE, '..', 'sites', 'sim_lab.yaml')


def text(path=CORRIDOR):
    with open(path) as f:
        return f.read()


def load(t, path=CORRIDOR):
    return check_text(t, path)[0]


def test_add_place_with_lane_keeps_comments():
    ed = SiteText(text())
    ed.set_place('scan_1', [0.5, -5.5, 1.57], 'from 834')
    ed.add_lane(['scan_1', 'fwd_2'])
    s = load(ed.text())
    assert s.places['scan_1'] == [0.5, -5.5, 1.57]
    assert ('scan_1', 'fwd_2', {}) in s.lanes and ('fwd_2', 'scan_1', {}) in s.lanes
    new = ed.text()
    assert '# 1 m ahead' in new and 'scan_1: [0.5, -5.5, 1.57]   # from 834' in new
    # only added lines: the rest of the file is untouched
    assert set(text().splitlines()) <= set(new.splitlines())


def test_new_place_without_lane_is_refused():
    ed = SiteText(text())
    ed.set_place('island', [5, 5, 0])
    with pytest.raises(EditError, match='no lanes'):
        load(ed.text())


def test_move_place_replaces_only_its_line():
    ed = SiteText(text())
    ed.set_place('fwd_1', [-1.0, -6.5, 0.0])
    old, new = text().splitlines(), ed.text().splitlines()
    assert len(old) == len(new)
    changed = [(a, b) for a, b in zip(old, new) if a != b]
    assert len(changed) == 1 and changed[0][1].strip() == 'fwd_1: [-1, -6.5, 0]'
    assert load(ed.text()).places['fwd_1'] == [-1.0, -6.5, 0.0]


def test_remove_place_splits_its_lanes():
    ed = SiteText(text())
    ed.set_place('scan_1', [0.5, -5.5, 0.0])
    ed.add_lane(['fwd_2', 'scan_1'])
    ed.remove_place('scan_1')
    assert yaml.safe_load(ed.text()) == yaml.safe_load(text())
    # a place in the middle of a chain: the chain splits around it
    ed = SiteText('places:\n  a: [0, 0]\n  b: [1, 0]\n  c: [2, 0]\n  d: [3, 0]\n'
                  'lanes:\n  - [a, b, c, d]\n')
    ed.remove_place('b')
    assert yaml.safe_load(ed.text())['lanes'] == [['c', 'd']]


def test_used_place_reports_its_users():
    s = Site.load(CORRIDOR)
    assert set(place_uses(s, 'fwd_1')) == {'formation line', 'zone corridor_probe'}
    assert set(place_uses(s, 'home_834')) == {'route corridor', 'robot 834 home'}


def test_remove_lane_splits_a_chain():
    ed = SiteText(text())
    ed.add_lane(['fwd_2', 'home_834'])      # a shortcut, then take it away again
    assert ed.lane_exists('home_834', 'fwd_2')
    ed.remove_lane('home_834', 'fwd_2')
    assert not ed.lane_exists('fwd_2', 'home_834')
    ed.remove_lane('fwd_1', 'fwd_2')         # middle of [home_834, fwd_1, fwd_2]
    lanes = yaml.safe_load(ed.text())['lanes']
    assert lanes == [['home_834', 'fwd_1']]
    with pytest.raises(EditError, match='no lane'):
        ed.remove_lane('fwd_1', 'fwd_2')


def test_oneway_lane_keeps_its_options():
    ed = SiteText('places:\n  a: [0, 0]\n  b: [1, 0]\n  c: [2, 0]\n'
                  'lanes:\n  - {path: [a, b, c], oneway: true}\n')
    ed.remove_lane('b', 'c')
    assert yaml.safe_load(ed.text())['lanes'] == [{'path': ['a', 'b'], 'oneway': True}]


def test_routes_set_replace_remove():
    ed = SiteText(text())
    ed.set_route('probe', ['fwd_1', 'fwd_2'])
    ed.set_route('corridor', ['fwd_1', 'home_834'])
    s = load(ed.text())
    assert s.routes == {'corridor': ['fwd_1', 'home_834'], 'probe': ['fwd_1', 'fwd_2']}
    ed.remove_route('probe')
    assert 'probe' not in load(ed.text()).routes


def test_dict_place_keeps_flags():
    ed = SiteText('places:\n  a: {pose: [0, 0, 0], parking: true}\n  b: [1, 0]\nlanes:\n  - [a, b]\n')
    ed.set_place('a', [0.5, 0, 0])
    assert yaml.safe_load(ed.text())['places']['a'] == {'pose': [0.5, 0, 0], 'parking': True}


def test_empty_sections_are_created():
    ed = SiteText('map_name: L1\nplaces: {}\n')
    ed.set_place('a', [0, 0, 0])
    ed.set_place('b', [1, 0, 0])
    ed.add_lane(['a', 'b'])
    ed.set_route('r', ['a', 'b'])
    d = yaml.safe_load(ed.text())
    assert d['places'] == {'a': [0, 0, 0], 'b': [1, 0, 0]}
    assert d['lanes'] == [['a', 'b']] and d['routes'] == {'r': ['a', 'b']}


def test_mission_breakage_is_reported():
    missions = [os.path.join(HERE, '..', 'missions', 'test_834_corridor.yaml')]
    ed = SiteText(text())
    ed.set_route('corridor', ['fwd_2', 'home_834'])     # no-op edit: nothing new broken
    assert check_text(ed.text(), CORRIDOR, missions, Site.load(CORRIDOR))[1] == []
    ed = SiteText(text().replace('  box_right:', '  box_left:'))
    broken = check_text(ed.text(), CORRIDOR, missions, Site.load(CORRIDOR))[1]
    assert len(broken) == 1 and 'box_right' in broken[0]
    # a mission that already failed (e.g. its zone not built yet) never blocks an edit
    failing = check_text(ed.text(), CORRIDOR)[0]            # the mission's target is gone
    ed.set_place('fwd_2', [0.0, -6.6, 0.0])                  # any further edit
    assert check_text(ed.text(), CORRIDOR, missions, failing)[1] == []


def test_sim_site_round_trip():
    # every place of a 3-robot site can be moved in place without changing anything else
    s = Site.load(SIM)
    ed = SiteText(text(SIM))
    for n, pose in s.places.items():
        ed.set_place(n, pose)
    got = load(ed.text(), SIM).places
    assert got.keys() == s.places.keys()
    for n in got:                           # written to 1 mm / 1 mrad
        assert got[n] == pytest.approx(s.places[n], abs=6e-4)


def test_new_site_loads_and_grows():
    from m20_rmf.siteedit import new_site
    t = new_site('834', '192.168.123.102', 30000, [-2.092, -6.49, -0.05], 'test')
    s = load(t, '/tmp/new.yaml')
    assert s.places == {'home_834': [-2.092, -6.49, -0.05]}
    assert s.robots['834']['ip'] == '192.168.123.102' and s.robots['834']['home'] == 'home_834'
    ed = SiteText(t)                       # the commands work on it straight away
    ed.set_place('bay_1', [-1.0, -6.5, 0.0])
    ed.add_lane(['bay_1', 'home_834'])
    ed.set_route('loop', ['bay_1', 'home_834'])
    s = load(ed.text(), '/tmp/new.yaml')
    assert set(s.places) == {'home_834', 'bay_1'} and s.routes == {'loop': ['bay_1', 'home_834']}
    assert '# Waypoints RMF can route to' in ed.text()     # comments kept


def test_robot_added_unplaced_then_placed():
    ed = SiteText(text())
    ed.set_robot('665', {'ip': '192.168.123.101'})
    s = load(ed.text())
    assert list(s.robots) == ['834'] and s.unplaced['665']['ip'] == '192.168.123.101'
    assert '"665": {ip: 192.168.123.101}' in ed.text()        # id quoted, one line
    ed.set_place('home_665', [-2.0, -5.0, 0.0])
    ed.add_lane(['home_665', 'home_834'])
    ed.set_robot('665', {'ip': '192.168.123.101', 'home': 'home_665'})
    s = load(ed.text())
    assert set(s.robots) == {'834', '665'} and not s.unplaced
    assert s.fleet_config()['rmf_fleet']['robots']['665'] == {'charger': 'home_665'}
