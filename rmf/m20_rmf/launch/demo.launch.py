"""Demo console: status hub + web GUI (http://localhost:8080), RViz markers, RViz.

    ros2 launch m20_rmf demo.launch.py [rviz:=false] [site:=...] [robots:=834]

Run next to m20_rmf.launch.py (same ROS domain). Site and robots default to
m20_stack.yaml, like the rest of the stack.
"""

import os
import tempfile

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, ExecuteProcess, OpaqueFunction
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def _nodes(context):
    from m20_rmf import stack
    from m20_rmf.sitefile import Site
    cfg = stack.load()
    site = LaunchConfiguration('site').perform(context) or cfg.get('site', '')
    if not site:
        raise RuntimeError('no site: pass site:= or set site: in m20_stack.yaml')
    robots = LaunchConfiguration('robots').perform(context) or \
        ','.join(stack.robots_for(site, cfg) or [])
    out = [
        Node(package='m20_rmf', executable='ui', output='both',
             arguments=['--site', site, '--robots', robots,
                        '--http-port', LaunchConfiguration('port').perform(context)]),
        Node(package='m20_rmf', executable='viz', output='both', arguments=['--site', site]),
    ]
    if LaunchConfiguration('rviz').perform(context).lower() == 'true':
        s = Site.load(site)
        pts = [p[:2] for p in s.places.values()]
        for z in s.zones.values():
            pts += [p[:2] for tr in (z['tracks'] or [z['poses']]) for p in tr]
        pts += [t['look_at'][:2] for t in s.targets.values() if t['look_at']]
        xs = [p[0] for p in pts] or [0.0]
        ys = [p[1] for p in pts] or [0.0]
        span = max(max(xs) - min(xs), max(ys) - min(ys), 4.0)
        share = get_package_share_directory('m20_rmf')
        with open(os.path.join(share, 'rviz', 'm20_demo.rviz')) as f:
            text = f.read()
        text = (text.replace('__X__', f'{(max(xs) + min(xs)) / 2:.2f}')
                    .replace('__Y__', f'{(max(ys) + min(ys)) / 2:.2f}')
                    .replace('__SCALE__', f'{900 / (span + 4):.1f}'))
        cfg_path = os.path.join(tempfile.gettempdir(), 'm20_demo.rviz')
        with open(cfg_path, 'w') as f:
            f.write(text)
        out.append(ExecuteProcess(cmd=['rviz2', '-d', cfg_path], output='both'))
    return out


def generate_launch_description():
    return LaunchDescription([
        DeclareLaunchArgument('site', default_value=''),
        DeclareLaunchArgument('robots', default_value=''),
        DeclareLaunchArgument('rviz', default_value='true'),
        DeclareLaunchArgument('port', default_value='8080', description='GUI port (websocket: +1)'),
        OpaqueFunction(function=_nodes),
    ])
