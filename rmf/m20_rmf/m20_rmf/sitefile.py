"""Site file: the one place a demo is laid out.

A site YAML names everything the mission primitives refer to — places, lanes,
patrol routes, formations, exploration zones, inspection targets and the robots —
and is compiled into the two files Open-RMF needs:

  * nav graph   (rmf_traffic Graph YAML: vertices + directed lanes)
  * fleet config (EasyFullControl config.yaml)

All coordinates are in the robots' shared SLAM `map` frame, which is also RMF's
frame (identity transform). Poses are [x, y, yaw_rad]; `m20 place set <name> --from
<robot>` records one from a robot standing on the spot (siteedit.py).

See sites/example_lab.yaml for the annotated schema.
"""

import copy
import itertools
import math
import os

import yaml

# Actions the fleet adapter implements (fleet_adapter.M20Robot.execute_action). They
# are advertised to RMF through the generated fleet config.
ADAPTER_ACTIONS = [
    'goto_pose', 'waypoints', 'explore', 'inspect', 'turn_to', 'dwell',
    'stand_up', 'relocalize', 'signal', 'wait_for_event',
]

FLEET_DEFAULTS = {
    'name': 'm20',
    'limits': {'linear': [0.6, 0.6], 'angular': [0.8, 1.5]},
    # RMF keeps one robot's footprint out of another's vicinity, so robots can
    # never be scheduled closer than footprint + vicinity (1.1 m here). Formation
    # slots and homes must be at least that far apart. M20 body ~0.9 x 0.45 m.
    'profile': {'footprint': 0.5, 'vicinity': 0.6},
    'reversible': False,
    'battery_system': {'voltage': 48.0, 'capacity': 30.0, 'charging_current': 10.0},
    'mechanical_system': {'mass': 50.0, 'moment_of_inertia': 10.0,
                          'friction_coefficient': 0.22},
    'ambient_system': {'power': 20.0},
    'tool_system': {'power': 0.0},
    # The M20 battery is not read over this protocol, so RMF plans as if it were full.
    'recharge_threshold': 0.0,
    'recharge_soc': 1.0,
    'account_for_battery_drain': False,
    'publish_fleet_state': 10.0,
    'task_capabilities': {'loop': True, 'delivery': False},
    'finishing_request': 'nothing',
    'responsive_wait': False,
}


class SiteError(ValueError):
    pass


def sweep(boundary, spacing=1.0, margin=0.4, angle=None):
    """Lawnmower coverage of a polygon: parallel rows `spacing` apart, kept `margin` in
    from the edges, walked back and forth. Rows run along the polygon's longest edge
    unless `angle` (degrees, map frame) is given. Returns [x, y, yaw] poses: each row's
    two ends, facing along the row. Convex shapes are covered fully; for a concave one
    each row takes its widest stretch."""
    n = len(boundary)
    if n < 3:
        return []
    if angle is None:
        a, b = max(((boundary[i], boundary[(i + 1) % n]) for i in range(n)),
                   key=lambda e: math.hypot(e[1][0] - e[0][0], e[1][1] - e[0][1]))
        ang = math.atan2(b[1] - a[1], b[0] - a[0])
    else:
        ang = math.radians(float(angle))
    c, s = math.cos(ang), math.sin(ang)
    # into the sweep frame: rows along +u, stacked along v
    uv = [(x * c + y * s, -x * s + y * c) for x, y in boundary]
    vs = [p[1] for p in uv]
    v0, v1 = min(vs) + margin, max(vs) - margin
    if v1 < v0:                        # narrower than two margins: one row down the middle
        v0 = v1 = (min(vs) + max(vs)) / 2
    rows = []
    count = int(math.floor((v1 - v0) / spacing + 1e-9)) + 1
    offset = ((v1 - v0) - (count - 1) * spacing) / 2       # centre the rows
    for i in range(count):
        v = v0 + offset + i * spacing
        xs = []
        for j in range(n):
            (pu, pv), (qu, qv) = uv[j], uv[(j + 1) % n]
            if (pv <= v < qv) or (qv <= v < pv):
                xs.append(pu + (v - pv) * (qu - pu) / (qv - pv))
        xs.sort()
        spans = [(xs[k] + margin, xs[k + 1] - margin) for k in range(0, len(xs) - 1, 2)]
        spans = [sp for sp in spans if sp[1] >= sp[0]]
        if spans:
            ua, ub = max(spans, key=lambda sp: sp[1] - sp[0])
            rows.append((ua, ub, v))
    poses = []
    for i, (ua, ub, v) in enumerate(rows):
        if i % 2:
            ua, ub = ub, ua
        yaw = ang + (0.0 if ub >= ua else math.pi)
        yaw = math.atan2(math.sin(yaw), math.cos(yaw))
        for u in ((ua, ub) if abs(ub - ua) > 1e-6 else (ua,)):
            poses.append([round(u * c - v * s, 3), round(u * s + v * c, 3), round(yaw, 4)])
    return poses


def _pose(v, where):
    if isinstance(v, dict):
        v = v.get('pose')
    if not isinstance(v, (list, tuple)) or len(v) not in (2, 3):
        raise SiteError(f'{where}: expected [x, y] or [x, y, yaw], got {v!r}')
    x, y = float(v[0]), float(v[1])
    yaw = float(v[2]) if len(v) == 3 else 0.0
    return [x, y, yaw]


class Site:
    def __init__(self, data, path=None):
        self.path = path
        self.raw = data
        self.map_name = str(data.get('map_name', 'L1'))
        # Optional saved SLAM map (.yaml, from `m20 map save`), drawn under the markers.
        m = data.get('map')
        self.map_file = None if not m else m if os.path.isabs(m) or not path else \
            os.path.join(os.path.dirname(os.path.abspath(path)), m)
        self.places = {}
        self.place_flags = {}
        for name, v in (data.get('places') or {}).items():
            self.places[str(name)] = _pose(v, f'places.{name}')
            self.place_flags[str(name)] = v if isinstance(v, dict) else {}
        self.lanes = self._parse_lanes(data.get('lanes') or [])
        self.routes = {str(k): [str(p) for p in v] for k, v in (data.get('routes') or {}).items()}
        self.formations = {}
        for k, v in (data.get('formations') or {}).items():
            v = v if isinstance(v, dict) else {'slots': v}
            self.formations[str(k)] = {
                'slots': [str(s) for s in v.get('slots', [])],
                'assign': v.get('assign', 'nearest'),
            }
        self.zones = {}
        for k, v in (data.get('zones') or {}).items():
            z = {'entry': v.get('entry'), 'exit': v.get('exit')}
            z['tracks'] = [[_pose(p, f'zones.{k}.tracks') for p in t] for t in v.get('tracks', [])]
            z['poses'] = [_pose(p, f'zones.{k}.poses') for p in v.get('poses', [])]
            # A boundary instead: the poses are a sweep over the area it encloses.
            # Corners are [x, y] or a place name (the corner follows the place if it moves).
            z['boundary'], z['corner_places'] = [], []
            for p in v.get('boundary', []):
                if isinstance(p, str):
                    if p not in self.places:
                        raise SiteError(f'zones.{k}.boundary: unknown place {p!r}')
                    z['corner_places'].append(p)
                    p = self.places[p]
                z['boundary'].append([float(p[0]), float(p[1])])
            z['spacing'] = float(v.get('spacing', 1.0))
            z['margin'] = float(v.get('margin', 0.4))
            if z['boundary'] and not z['tracks'] and not z['poses']:
                if z['spacing'] <= 0:
                    raise SiteError(f'zones.{k}.spacing must be > 0')
                z['poses'] = sweep(z['boundary'], z['spacing'], z['margin'], v.get('angle'))
            z['dwell'] = float(v.get('dwell', 0.0))
            self.zones[str(k)] = z
        self.targets = {}
        for k, v in (data.get('targets') or {}).items():
            t = {'approach': v.get('approach'),
                 'standoff': _pose(v['standoff'], f'targets.{k}.standoff') if 'standoff' in v else None,
                 'look_at': [float(c) for c in v['look_at']] if 'look_at' in v else None,
                 'dwell': float(v.get('dwell', 5.0)),
                 'timeout': float(v.get('timeout', 30.0)),
                 'label': v.get('label', k)}
            self.targets[str(k)] = t
        self.robots = {}
        for k, v in (data.get('robots') or {}).items():
            v = dict(v or {})
            v.setdefault('port', 30000)
            self.robots[str(k)] = v
        self.fleet = copy.deepcopy(FLEET_DEFAULTS)
        _deep_update(self.fleet, data.get('fleet') or {})
        self.validate()

    @classmethod
    def load(cls, path):
        with open(path) as f:
            return cls(yaml.safe_load(f) or {}, path)

    # ---------------------------------------------------------------- parsing
    def _parse_lanes(self, entries):
        lanes = []  # (a, b, props) directed
        for i, e in enumerate(entries):
            if isinstance(e, dict):
                path = e.get('path', [])
                oneway = bool(e.get('oneway', False))
                props = {k: v for k, v in e.items() if k in ('speed_limit',)}
            else:
                path, oneway, props = e, False, {}
            path = [str(p) for p in path]
            if len(path) < 2:
                raise SiteError(f'lanes[{i}]: needs at least two places')
            for a, b in zip(path, path[1:]):
                lanes.append((a, b, props))
                if not oneway:
                    lanes.append((b, a, props))
        return lanes

    def validate(self):
        def need(place, where):
            if place is not None and place not in self.places:
                raise SiteError(f'{where}: unknown place {place!r}')
        for a, b, _ in self.lanes:
            need(a, 'lanes')
            need(b, 'lanes')
        for k, r in self.routes.items():
            for p in r:
                need(p, f'routes.{k}')
        for k, f in self.formations.items():
            for p in f['slots']:
                need(p, f'formations.{k}')
            if f['assign'] not in ('nearest', 'fixed'):
                raise SiteError(f'formations.{k}.assign must be nearest|fixed')
        for k, z in self.zones.items():
            need(z['entry'], f'zones.{k}.entry')
            need(z['exit'], f'zones.{k}.exit')
            if not z['tracks'] and not z['poses']:
                if not z['boundary']:
                    raise SiteError(f'zones.{k}: needs tracks, poses or a boundary')
        for k, t in self.targets.items():
            need(t['approach'], f'targets.{k}.approach')
            if t['approach'] is None and t['standoff'] is None:
                raise SiteError(f'targets.{k}: needs approach and/or standoff')
        for k, r in self.robots.items():
            if 'ip' not in r:
                raise SiteError(f'robots.{k}: missing ip')
            need(r.get('home'), f'robots.{k}.home')
            if r.get('route') is not None and r['route'] not in self.routes:
                raise SiteError(f'robots.{k}.route: unknown route {r["route"]!r}')
            if r.get('home') is None:
                raise SiteError(f'robots.{k}: missing home (used as its RMF charger)')
        connected = {a for a, _, _ in self.lanes} | {b for _, b, _ in self.lanes}
        for p in self.places:
            if p not in connected and len(self.places) > 1:
                raise SiteError(f'place {p!r} has no lanes; RMF could never route to it')

    def min_separation(self):
        p = self.fleet['profile']
        return float(p['footprint']) + float(p['vicinity'])

    def warnings(self):
        """Layout problems RMF will not reject but will fight with at run time."""
        out = []
        for k, z in self.zones.items():
            if z['boundary'] and not z['tracks'] and len(z['boundary']) < 3:
                out.append(f'zone {k}: {len(z["boundary"])} boundary corner(s); it needs at '
                           'least 3 before it can be explored')
            elif z['boundary'] and not z['poses'] and not z['tracks']:
                out.append(f'zone {k}: the area is too small for spacing {z["spacing"]} m / '
                           f'margin {z["margin"]} m: nothing to explore')
        sep = self.min_separation()
        groups = {f'formation {k}': f['slots'] for k, f in self.formations.items()}
        groups['robot homes'] = [r['home'] for r in self.robots.values()]
        for label, names in groups.items():
            for a, b in itertools.combinations(names, 2):
                d = math.hypot(self.places[a][0] - self.places[b][0],
                               self.places[a][1] - self.places[b][1])
                if d < sep:
                    out.append(f'{label}: {a} and {b} are {d:.2f} m apart, below RMF '
                               f'separation {sep:.2f} m (footprint+vicinity); expect '
                               'negotiation failures')
        return out

    # ---------------------------------------------------------------- queries
    def place(self, name):
        if name not in self.places:
            raise SiteError(f'unknown place {name!r}')
        return self.places[name]

    def resolve_pose(self, ref):
        """A place name, or an inline [x, y(, yaw)]."""
        if isinstance(ref, str):
            return self.place(ref)
        return _pose(ref, 'pose')

    def nearest_place(self, x, y):
        return min(self.places, key=lambda n: math.hypot(self.places[n][0] - x, self.places[n][1] - y))

    def robot_ids(self):
        return list(self.robots)

    # ------------------------------------------------------------- generation
    def nav_graph(self):
        names = list(self.places)
        index = {n: i for i, n in enumerate(names)}
        chargers = {r.get('home') for r in self.robots.values()}
        vertices = []
        for n in names:
            x, y, _ = self.places[n]
            flags = self.place_flags[n]
            props = {'name': n}
            if n in chargers or flags.get('charger'):
                props['is_charger'] = True
            if flags.get('parking') or n in chargers:
                props['is_parking_spot'] = True
            if flags.get('holding'):
                props['is_holding_point'] = True
            vertices.append([x, y, props])
        lanes = []
        for a, b, props in self.lanes:
            lp = {'speed_limit': float(props.get('speed_limit', 0.0))}
            lanes.append([index[a], index[b], lp])
        return {'building_name': 'm20_site', 'doors': {}, 'lifts': {},
                'levels': {self.map_name: {'vertices': vertices, 'lanes': lanes}}}

    def fleet_config(self):
        fleet = copy.deepcopy(self.fleet)
        fleet['actions'] = list(ADAPTER_ACTIONS)
        fleet['robots'] = {rid: {'charger': r['home']} for rid, r in self.robots.items()}
        return {'rmf_fleet': fleet}

    def write(self, nav_graph_path, fleet_config_path):
        with open(nav_graph_path, 'w') as f:
            yaml.safe_dump(self.nav_graph(), f, sort_keys=False)
        with open(fleet_config_path, 'w') as f:
            yaml.safe_dump(self.fleet_config(), f, sort_keys=False)


def _deep_update(dst, src):
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            _deep_update(dst[k], v)
        else:
            dst[k] = v
