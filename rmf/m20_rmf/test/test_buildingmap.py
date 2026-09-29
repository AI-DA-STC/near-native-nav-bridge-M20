"""The site as an Open-RMF BuildingMap (for the rmf-web dashboard / rmf_visualization)."""

import math
import os
import struct
import zlib

from m20_rmf import buildingmap, mapfile
from m20_rmf.sitefile import Site
from rmf_building_map_msgs.msg import GraphEdge

HERE = os.path.dirname(__file__)
CORRIDOR = os.path.join(HERE, '..', 'sites', 'lab_834_corridor.yaml')


def _png_pixels(png):
    assert png[:8] == b'\x89PNG\r\n\x1a\n'
    w, h = struct.unpack('>II', png[16:24])
    i, idat = 8, b''
    while i < len(png):
        n = struct.unpack('>I', png[i:i + 4])[0]
        kind = png[i + 4:i + 8]
        if kind == b'IDAT':
            idat += png[i + 8:i + 8 + n]
        i += 12 + n
    raw = zlib.decompress(idat)
    rows = [raw[r * (w + 1) + 1:(r + 1) * (w + 1)] for r in range(h)]
    return w, h, rows


def test_png_top_row_is_the_maps_last_row():
    # 3x2 map, row 0 = bottom: bottom row free, top row occupied/unknown/free
    data = [0, 0, 0, 100, -1, 0]
    w, h, rows = _png_pixels(mapfile.to_png(3, 2, data))
    assert (w, h) == (3, 2)
    assert list(rows[0]) == [0, 205, 254] and list(rows[1]) == [254, 254, 254]


def test_building_map_from_site_and_map():
    site = Site.load(CORRIDOR)
    grid = mapfile.load(site.map_file)
    m = buildingmap.building_map(site, grid)
    level = m.levels[0]
    assert level.name == site.map_name
    im = level.images[0]
    res = grid['resolution']
    # the image's top-left pixel sits at the map's top-left corner
    assert math.isclose(im.x_offset, grid['origin'][0], abs_tol=1e-6)
    assert math.isclose(im.y_offset, grid['origin'][1] + grid['height'] * res, abs_tol=1e-6)
    assert math.isclose(im.scale, res, rel_tol=1e-6) and im.encoding == 'png'
    g = level.nav_graphs[0]
    names = [v.name for v in g.vertices]
    assert set(names) == set(site.places)
    home = g.vertices[names.index('home_834')]
    assert {p.name for p in home.params} == {'is_charger', 'is_parking_spot'}
    # [home_834, fwd_1, fwd_2] two-way: two bidirectional edges, not four one-way ones
    assert len(g.edges) == 2
    assert all(e.edge_type == GraphEdge.EDGE_TYPE_BIDIRECTIONAL for e in g.edges)
    # walls frame the site
    xs = [v.x for v in level.wall_graph.vertices]
    ys = [v.y for v in level.wall_graph.vertices]
    for x, y, _ in site.places.values():
        assert min(xs) < x < max(xs) and min(ys) < y < max(ys)


def test_oneway_lane_stays_one_way():
    site = Site({'places': {'a': [0, 0], 'b': [1, 0]},
                 'lanes': [{'path': ['a', 'b'], 'oneway': True}],
                 'robots': {'1': {'ip': '1.2.3.4', 'home': 'a'}}})
    g = buildingmap.building_map(site).levels[0].nav_graphs[0]
    assert [(e.v1_idx, e.v2_idx, e.edge_type) for e in g.edges] == \
        [(0, 1, GraphEdge.EDGE_TYPE_UNIDIRECTIONAL)]
