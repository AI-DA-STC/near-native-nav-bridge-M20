"""The site as an Open-RMF BuildingMap, for Open-RMF's own tools (the rmf-web dashboard,
rmf_visualization's floorplan/navgraph layers), which read /map.

Open-RMF normally gets this from a .building.yaml drawn in its traffic editor; here it
comes from the site file and the saved SLAM map instead, so nothing is drawn twice:
  * level:     site.map_name (the level the fleet adapter reports robots on)
  * image:     the SLAM map (PNG, 4x upscaled) with the site drawn on it in the RViz
               / console colours: lanes, formation slots, zones (boundary + sweep),
               targets. The dashboard draws robots and waypoints (with names) itself.
  * nav graph: places (named, homes as chargers/parking) and lanes
  * walls:     the map's outline (the dashboard frames its view on the walls)
"""

import math

from rmf_building_map_msgs.msg import (AffineImage, BuildingMap, Graph, GraphEdge,
                                       GraphNode, Level, Param)

from . import mapfile
from .view import MODES

UPSCALE = 4                     # image pixels per map cell: thin lines stay sharp
LANE, SLOT, ZONE, TARGET = '#334155', MODES['REGROUP'], MODES['EXPLORE'], MODES['INVESTIGATE']


def _rgb(hex_color):
    h = hex_color.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


class Canvas:
    """RGB raster of the map in map-frame coordinates (no imaging library)."""

    def __init__(self, grid, k=UPSCALE):
        self.k, self.res = k, float(grid['resolution'])
        self.ox, self.oy = float(grid['origin'][0]), float(grid['origin'][1])
        w, h = grid['width'], grid['height']
        self.W, self.H = w * k, h * k
        shade = {-1: (205, 205, 205)}
        rows = []
        for r in range(h - 1, -1, -1):                  # image rows run top-down
            row = bytearray()
            for v in grid['data'][r * w:(r + 1) * w]:
                c = shade.get(v) or ((254, 254, 254) if v <= 25 else (0, 0, 0) if v >= 65
                                     else (128, 128, 128))
                row.extend(bytes(c) * k)
            rows.extend([row] * k)
        self.px = bytearray(b''.join(rows))

    def to_px(self, x, y):
        return ((x - self.ox) / self.res * self.k, self.H - (y - self.oy) / self.res * self.k)

    def dot(self, cx, cy, r, color, alpha=1.0):
        """Filled disc at pixel (cx, cy), radius r pixels."""
        for py in range(max(0, int(cy - r)), min(self.H, int(cy + r) + 1)):
            for px in range(max(0, int(cx - r)), min(self.W, int(cx + r) + 1)):
                if (px - cx) ** 2 + (py - cy) ** 2 <= r * r:
                    i = (py * self.W + px) * 3
                    for c in range(3):
                        self.px[i + c] = int(self.px[i + c] * (1 - alpha) + color[c] * alpha)

    def line(self, a, b, width_m, color, alpha=1.0):
        (x0, y0), (x1, y1) = self.to_px(*a), self.to_px(*b)
        r = max(1.0, width_m / self.res * self.k / 2)
        n = max(1, int(math.hypot(x1 - x0, y1 - y0) / max(1.0, r / 2)))
        done = set()
        for i in range(n + 1):
            p = (round(x0 + (x1 - x0) * i / n), round(y0 + (y1 - y0) * i / n))
            if p not in done:
                done.add(p)
                self.dot(p[0], p[1], r, color, alpha)

    def disc(self, x, y, radius_m, color, alpha=1.0):
        cx, cy = self.to_px(x, y)
        self.dot(cx, cy, radius_m / self.res * self.k, color, alpha)

    def square(self, x, y, side_m, color):
        cx, cy = self.to_px(x, y)
        h = side_m / self.res * self.k / 2
        for py in range(max(0, int(cy - h)), min(self.H, int(cy + h))):
            for px in range(max(0, int(cx - h)), min(self.W, int(cx + h))):
                i = (py * self.W + px) * 3
                self.px[i:i + 3] = bytes(color)

    def png(self):
        import struct
        import zlib
        stride = self.W * 3
        raw = b''.join(b'\x00' + bytes(self.px[r * stride:(r + 1) * stride]) for r in range(self.H))

        def chunk(kind, body):
            return (struct.pack('>I', len(body)) + kind + body +
                    struct.pack('>I', zlib.crc32(kind + body) & 0xffffffff))
        return (b'\x89PNG\r\n\x1a\n' +
                chunk(b'IHDR', struct.pack('>IIBBBBB', self.W, self.H, 8, 2, 0, 0, 0)) +
                chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b''))


def site_image(site, grid, k=UPSCALE):
    """The SLAM map with the site drawn on: PNG bytes, k image pixels per map cell."""
    cv = Canvas(grid, k)
    lane, slot, zone, target = _rgb(LANE), _rgb(SLOT), _rgb(ZONE), _rgb(TARGET)
    for f in site.formations.values():
        for sname in f['slots']:
            cv.disc(*site.places[sname][:2], 0.35, slot, 0.35)
    done = set()
    for a, b, _ in site.lanes:
        if (b, a) not in done:
            done.add((a, b))
            cv.line(site.places[a][:2], site.places[b][:2], 0.08, lane, 0.9)
    for z in site.zones.values():
        ring = z['boundary'] + z['boundary'][:1] if len(z['boundary']) > 2 else z['boundary']
        for p, q in zip(ring, ring[1:]):
            cv.line(p[:2], q[:2], 0.04, zone, 0.6)
        for track in (z['tracks'] or [z['poses']]):
            for p, q in zip(track, track[1:]):
                cv.line(p[:2], q[:2], 0.06, zone, 0.9)
    for t in site.targets.values():
        if t['look_at']:
            xy = t['look_at']
        elif t['standoff']:
            xy = t['standoff']
        else:
            xy = site.places[t['approach']]
        cv.square(xy[0], xy[1], 0.4, target)
    return cv.png()


def _param(name, value):
    p = Param(name=name)
    if isinstance(value, bool):
        p.type, p.value_bool = Param.TYPE_BOOL, value
    elif isinstance(value, int):
        p.type, p.value_int = Param.TYPE_INT, value
    elif isinstance(value, float):
        p.type, p.value_float = Param.TYPE_DOUBLE, value
    else:
        p.type, p.value_string = Param.TYPE_STRING, str(value)
    return p


def nav_graph(site):
    homes = {r['home'] for r in site.robots.values()}
    names = list(site.places)
    g = Graph(name='0')
    for n in names:
        x, y, _ = site.places[n]
        node = GraphNode(x=float(x), y=float(y), name=n)
        if n in homes:
            node.params = [_param('is_charger', True), _param('is_parking_spot', True)]
        g.vertices.append(node)
    index = {n: i for i, n in enumerate(names)}
    edge_of = {}                                # (a, b) -> index of its edge
    for a, b, _ in site.lanes:
        if (b, a) in edge_of:                   # both directions: one two-way edge
            g.edges[edge_of[(b, a)]].edge_type = GraphEdge.EDGE_TYPE_BIDIRECTIONAL
            continue
        edge_of[(a, b)] = len(g.edges)
        g.edges.append(GraphEdge(v1_idx=index[a], v2_idx=index[b],
                                 edge_type=GraphEdge.EDGE_TYPE_UNIDIRECTIONAL))
    return g


def outline(x0, y0, x1, y1):
    """A rectangle of walls."""
    w = Graph(name='walls')
    for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
        w.vertices.append(GraphNode(x=float(x), y=float(y)))
    for i in range(4):
        w.edges.append(GraphEdge(v1_idx=i, v2_idx=(i + 1) % 4,
                                 edge_type=GraphEdge.EDGE_TYPE_BIDIRECTIONAL))
    return w


MARGIN = 3.0                    # m of map shown around the site


def site_bounds(site, margin=MARGIN):
    """(x0, y0, x1, y1) around every place, zone and target, plus a margin."""
    pts = [p[:2] for p in site.places.values()]
    for z in site.zones.values():
        pts += [p[:2] for p in z['boundary'] + [q for t in z['tracks'] for q in t] + z['poses']]
    pts += [t['look_at'][:2] for t in site.targets.values() if t['look_at']]
    pts = pts or [(0.0, 0.0)]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs) - margin, min(ys) - margin, max(xs) + margin, max(ys) + margin


def crop(grid, bounds):
    """The part of an occupancy grid inside bounds (x0, y0, x1, y1); None if outside."""
    res, (ox, oy) = float(grid['resolution']), (float(grid['origin'][0]), float(grid['origin'][1]))
    w, h = grid['width'], grid['height']
    c0 = max(0, int((bounds[0] - ox) / res))
    r0 = max(0, int((bounds[1] - oy) / res))
    c1 = min(w, int(math.ceil((bounds[2] - ox) / res)))
    r1 = min(h, int(math.ceil((bounds[3] - oy) / res)))
    if c1 <= c0 or r1 <= r0:
        return None
    data = []
    for r in range(r0, r1):
        data.extend(grid['data'][r * w + c0:r * w + c1])
    return {'width': c1 - c0, 'height': r1 - r0, 'resolution': res, 'data': data,
            'origin': [ox + c0 * res, oy + r0 * res] + list(grid['origin'][2:3])}


def building_map(site, grid=None, name='m20_site'):
    """grid: mapfile.load() dict (row 0 = bottom), or None for no floor image. The floor
    image is the map cropped to the site (plus a margin): the dashboard frames its view on
    the scene, so a large SLAM map would leave the site small in the middle."""
    level = Level(name=site.map_name, elevation=0.0)
    level.nav_graphs = [nav_graph(site)]
    x0, y0, x1, y1 = site_bounds(site)
    if grid is not None:
        grid = crop(grid, (x0, y0, x1, y1))
    if grid is not None:
        res = float(grid['resolution'])
        ox, oy = float(grid['origin'][0]), float(grid['origin'][1])
        yaw = float(grid['origin'][2]) if len(grid['origin']) > 2 else 0.0
        level.images = [AffineImage(
            name='slam_map', encoding='png', scale=res / UPSCALE, yaw=yaw,
            # top-left pixel, in the map frame (image rows run downwards)
            x_offset=ox - grid['height'] * res * math.sin(yaw),
            y_offset=oy + grid['height'] * res * math.cos(yaw),
            data=list(site_image(site, grid)))]
    level.wall_graph = outline(x0, y0, x1, y1)     # frames the dashboard's view
    return BuildingMap(name=name, levels=[level])
