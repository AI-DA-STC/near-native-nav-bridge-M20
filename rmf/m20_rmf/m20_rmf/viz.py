"""RViz markers for the demo: the site, and each robot in its mode colour.

    ros2 run m20_rmf viz           (started by demo.launch.py, with RViz)

Draws on /m20/viz (MarkerArray, frame `map`):
  site     lanes, places (named), formation slots, exploration tracks, targets
  robots   body oriented by heading + "834 · PATROL" label, in the mode colour
  plans    line from the robot along its remaining path to its goal
  focus    the target being investigated, highlighted
and /m20/map (OccupancyGrid, latched): the site's saved SLAM map (`map:` in the site
file, from `m20 map save`), or else the robots' live /GRID_MAP_relayed_<id>, so RViz
always has one map layer under the markers.
Robot state comes only from /m20/fleet_view (the status hub), the same view the web
GUI renders, so the two always agree.
"""

import argparse
import json
import math
import sys

import rclpy
import rclpy.node
from builtin_interfaces.msg import Duration
from geometry_msgs.msg import Point
from nav_msgs.msg import OccupancyGrid
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from std_msgs.msg import ColorRGBA, String
from visualization_msgs.msg import Marker, MarkerArray

from . import stack
from .sitefile import Site
from .view import MODES

# Drawn over the robots' SLAM map (light free space, black walls): dark, saturated
# colours read on it; the robot colours are the mode colours of view.MODES.
GREY = '#1e293b'
DIM = '#334155'


def rgba(hex_color, a=1.0):
    h = hex_color.lstrip('#')
    return ColorRGBA(r=int(h[0:2], 16) / 255, g=int(h[2:4], 16) / 255,
                     b=int(h[4:6], 16) / 255, a=a)


def pt(x, y, z=0.0):
    return Point(x=float(x), y=float(y), z=float(z))


class Markers:
    """Builds marker lists; no ROS node, so it is unit-testable."""

    def __init__(self, site, frame='map'):
        self.site = site
        self.frame = frame
        self._id = 0

    def _m(self, ns, kind, color, scale=(1.0, 1.0, 1.0), lifetime=0.0):
        m = Marker()
        m.header.frame_id = self.frame
        m.ns, m.type, m.action = ns, kind, Marker.ADD
        self._id += 1
        m.id = self._id
        m.scale.x, m.scale.y, m.scale.z = (float(v) for v in scale)
        m.color = color
        m.pose.orientation.w = 1.0
        if lifetime:
            m.lifetime = Duration(sec=int(lifetime), nanosec=int((lifetime % 1) * 1e9))
        return m

    def _text(self, ns, x, y, z, text, color, size=0.25, lifetime=0.0):
        m = self._m(ns, Marker.TEXT_VIEW_FACING, color, (0, 0, size), lifetime)
        m.pose.position = pt(x, y, z)
        m.text = text
        return m

    def site_markers(self):
        s, out = self.site, []
        lanes = self._m('site/lanes', Marker.LINE_LIST, rgba(DIM, 0.9), (0.08, 0, 0))
        done = set()
        for a, b, _ in s.lanes:
            if (b, a) in done:
                continue
            done.add((a, b))
            lanes.points += [pt(*s.places[a][:2]), pt(*s.places[b][:2])]
        out.append(lanes)
        places = self._m('site/places', Marker.SPHERE_LIST, rgba(GREY, 0.95), (0.18, 0.18, 0.18))
        for name, (x, y, _) in s.places.items():
            places.points.append(pt(x, y, 0.02))
            out.append(self._text('site/names', x, y + 0.28, 0.05, name, rgba(GREY, 0.9), 0.2))
        out.append(places)
        for fname, f in s.formations.items():
            for slot in f['slots']:
                x, y, _ = s.places[slot]
                ring = self._m('site/formations', Marker.CYLINDER, rgba(MODES['REGROUP'], 0.35),
                               (0.7, 0.7, 0.02))
                ring.pose.position = pt(x, y, 0.01)
                out.append(ring)
        for zname, z in s.zones.items():
            tracks = z['tracks'] or [z['poses']]
            for tr in tracks:
                line = self._m('site/zones', Marker.LINE_STRIP, rgba(MODES['EXPLORE'], 0.9),
                               (0.06, 0, 0))
                line.points = [pt(p[0], p[1], 0.02) for p in tr]
                out.append(line)
            if tracks and tracks[0]:
                x, y = tracks[0][0][:2]
                out.append(self._text('site/names', x, y - 0.3, 0.05, zname,
                                      rgba(MODES['EXPLORE'], 0.9), 0.18))
        for tname, t in s.targets.items():
            x, y = self._target_xy(t)
            box = self._m('site/targets', Marker.CUBE, rgba(MODES['INVESTIGATE'], 0.8),
                          (0.4, 0.4, 0.4))
            box.pose.position = pt(x, y, 0.2)
            out.append(box)
            out.append(self._text('site/names', x, y + 0.4, 0.5, t['label'],
                                  rgba(MODES['INVESTIGATE'], 1.0), 0.2))
        return out

    def _target_xy(self, t):
        if t['look_at']:
            return t['look_at'][:2]
        if t['standoff']:
            return t['standoff'][:2]
        return self.site.places[t['approach']][:2]

    def robot_markers(self, view, now=0.0):
        out = []
        life = 1.5      # vanish if the view stops coming
        for r in view.get('robots', []):
            if not r.get('pose'):
                continue
            x, y, yaw = r['pose']
            color = rgba(r['color'])
            body = self._m('robots/body', Marker.CUBE, color, (0.8, 0.42, 0.3), life)
            body.pose.position = pt(x, y, 0.3)
            body.pose.orientation.z, body.pose.orientation.w = math.sin(yaw / 2), math.cos(yaw / 2)
            out.append(body)
            nose = self._m('robots/body', Marker.ARROW, rgba('#ffffff', 0.9), (0.06, 0.14, 0.14), life)
            nose.points = [pt(x, y, 0.5), pt(x + 0.55 * math.cos(yaw), y + 0.55 * math.sin(yaw), 0.5)]
            out.append(nose)
            # Two lines: RViz draws spaces very wide and has no middle-dot glyph.
            label = f'{r["id"]}\n{r["mode"]}'
            out.append(self._text('robots/label', x, y + 0.7, 1.0, label, color, 0.3, life))
            # plan: remaining path (actions) then the current goal
            pts = [pt(x, y, 0.05)] + [pt(p[0], p[1], 0.05) for p in r.get('path') or []]
            if r.get('goal') and not r.get('path'):
                pts.append(pt(r['goal'][0], r['goal'][1], 0.05))
            if len(pts) > 1:
                plan = self._m('robots/plan', Marker.LINE_STRIP, rgba(r['color'], 0.9),
                               (0.08, 0, 0), life)
                plan.points = pts
                out.append(plan)
                end = self._m('robots/plan', Marker.SPHERE, rgba(r['color'], 0.9),
                              (0.18, 0.18, 0.18), life)
                end.pose.position = pts[-1]
                out.append(end)
        # the target under investigation, pulsing
        for ins in (view.get('inspections') or {}).values():
            t = self.site.targets.get(ins.get('target'))
            if t is None:
                continue
            x, y = self._target_xy(t)
            a = 0.35 + 0.35 * (1 + math.sin(now * 4)) / 2
            halo = self._m('robots/focus', Marker.SPHERE, rgba(MODES['INVESTIGATE'], a),
                           (1.0, 1.0, 1.0), life)
            halo.pose.position = pt(x, y, 0.2)
            out.append(halo)
        return out


def main(argv=None):
    from . import domain_guard
    argv = list(argv or sys.argv)
    domain_guard.check(argv=argv)
    rclpy.init(args=argv)
    p = argparse.ArgumentParser(prog='m20_viz')
    p.add_argument('--site', default='')
    a = p.parse_args(rclpy.utilities.remove_ros_args(argv)[1:])
    site_path = a.site or stack.load().get('site')
    if not site_path:
        sys.exit('no site: pass --site or set site: in m20_stack.yaml')
    node = rclpy.node.Node('m20_viz')
    pub = node.create_publisher(MarkerArray, '/m20/viz', 10)
    state = {'view': {}, 'site': Site.load(site_path)}

    def on_view(msg):
        state['view'] = json.loads(msg.data)
    node.create_subscription(String, '/m20/fleet_view', on_view, 10)

    latched = QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE,
                         durability=DurabilityPolicy.TRANSIENT_LOCAL)
    map_pub = node.create_publisher(OccupancyGrid, '/m20/map', latched)
    site = state['site']
    if site.map_file:
        from . import mapfile
        mp = mapfile.load(site.map_file)
        grid = OccupancyGrid()
        grid.header.frame_id = 'map'
        grid.header.stamp = node.get_clock().now().to_msg()
        grid.info.resolution = mp['resolution']
        grid.info.width, grid.info.height = mp['width'], mp['height']
        grid.info.origin.position.x, grid.info.origin.position.y = (float(v) for v in mp['origin'][:2])
        grid.info.origin.orientation.w = 1.0
        grid.data = mp['data']
        map_pub.publish(grid)
        node.get_logger().info(f'/m20/map: saved map {site.map_file}')
    else:
        # No saved map: pass the first robot's live SLAM map through (latched).
        rid = next(iter(site.robots), None)
        if rid:
            node.create_subscription(OccupancyGrid, f'/GRID_MAP_relayed_{rid}',
                                     map_pub.publish, latched)
            node.get_logger().info(f'/m20/map: live /GRID_MAP_relayed_{rid}')

    def tick():
        mk = Markers(state['site'])
        now = node.get_clock().now().nanoseconds / 1e9
        arr = MarkerArray()
        clear = Marker()
        clear.action = Marker.DELETEALL
        arr.markers = [clear] + mk.site_markers() + mk.robot_markers(state['view'], now)
        pub.publish(arr)
    node.create_timer(0.25, tick)
    node.get_logger().info(f'publishing /m20/viz for site {site_path}')
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    rclpy.try_shutdown()


if __name__ == '__main__':
    main()
