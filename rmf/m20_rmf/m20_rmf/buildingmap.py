"""The site as an Open-RMF BuildingMap, for Open-RMF's own tools (the rmf-web dashboard,
rmf_visualization's floorplan/navgraph layers), which read /map.

Open-RMF normally gets this from a .building.yaml drawn in its traffic editor; here it
comes from the site file and the saved SLAM map instead, so nothing is drawn twice:
  * level:     site.map_name (the level the fleet adapter reports robots on)
  * image:     the SLAM map (PNG), placed by its top-left corner in the map frame
  * nav graph: places (named, homes as chargers/parking) and lanes
  * walls:     the map's outline (the dashboard frames its view on the walls)
"""

import math

from rmf_building_map_msgs.msg import (AffineImage, BuildingMap, Graph, GraphEdge,
                                       GraphNode, Level, Param)

from . import mapfile


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


def building_map(site, grid=None, name='m20_site'):
    """grid: mapfile.load() dict (row 0 = bottom), or None for no floor image."""
    level = Level(name=site.map_name, elevation=0.0)
    level.nav_graphs = [nav_graph(site)]
    xs = [p[0] for p in site.places.values()] or [0.0]
    ys = [p[1] for p in site.places.values()] or [0.0]
    x0, y0, x1, y1 = min(xs) - 2, min(ys) - 2, max(xs) + 2, max(ys) + 2
    if grid is not None:
        res = float(grid['resolution'])
        ox, oy = float(grid['origin'][0]), float(grid['origin'][1])
        yaw = float(grid['origin'][2]) if len(grid['origin']) > 2 else 0.0
        level.images = [AffineImage(
            name='slam_map', encoding='png', scale=res, yaw=yaw,
            # top-left pixel, in the map frame (image rows run downwards)
            x_offset=ox - grid['height'] * res * math.sin(yaw),
            y_offset=oy + grid['height'] * res * math.cos(yaw),
            data=list(mapfile.to_png(grid['width'], grid['height'], grid['data'])))]
    # The walls frame the dashboard's view: around the site (places + zones + targets),
    # not the whole SLAM map, which can be much larger than the demo area.
    for z in site.zones.values():
        for p in z['boundary'] + [q for t in z['tracks'] for q in t] + z['poses']:
            x0, y0, x1, y1 = min(x0, p[0] - 2), min(y0, p[1] - 2), max(x1, p[0] + 2), max(y1, p[1] + 2)
    level.wall_graph = outline(x0, y0, x1, y1)
    return BuildingMap(name=name, levels=[level])
