"""Bring up Open-RMF for the M20 fleet.

    ros2 launch m20_rmf m20_rmf.launch.py site:=/repo/rmf/m20_rmf/sites/sim_lab.yaml sim:=true
    ros2 launch m20_rmf m20_rmf.launch.py site:=<real site> robots:=834

Starts: traffic schedule + blockade moderator, task dispatcher, the task monitor
(websocket :7878 -> /m20/task_states), the M20 fleet adapter, optionally mock robots
(sim:=true) and the RMF visualizers + RViz (viz:=true).
"""

import os

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, ExecuteProcess, OpaqueFunction
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node
from ament_index_python.packages import get_package_share_directory


def _nodes(context):
    site = LaunchConfiguration('site').perform(context)
    robots = LaunchConfiguration('robots').perform(context)
    from m20_rmf.sitefile import Site
    s = Site.load(site)     # fail fast on a bad site file, before anything starts
    fleet = s.fleet['name']
    footprint = float(s.fleet['profile']['footprint'])
    ws = 'ws://localhost:7878'
    out = [
        # Monitor first: the dispatcher and adapter connect to its websocket on start.
        Node(package='m20_rmf', executable='monitor', output='both'),
        Node(package='rmf_traffic_ros2', executable='rmf_traffic_schedule', output='both'),
        Node(package='rmf_traffic_ros2', executable='rmf_traffic_blockade', output='both'),
        Node(package='rmf_task_ros2', executable='rmf_task_dispatcher', output='both',
             parameters=[{'bidding_time_window': 2.0, 'server_uri': ws}]),
        Node(package='m20_rmf', executable='fleet_adapter', output='both',
             arguments=['--site', site, '--robots', robots, '--server-uri', ws]),
    ]
    if LaunchConfiguration('sim').perform(context).lower() == 'true':
        out.append(Node(package='m20_rmf', executable='mock_robot', output='both',
                        arguments=['--site', site, '--robots', robots]))
    if LaunchConfiguration('viz').perform(context).lower() == 'true':
        out += [
            Node(package='rmf_visualization_schedule', executable='schedule_visualizer_node',
                 parameters=[{'initial_map_name': s.map_name}]),
            Node(package='rmf_visualization_fleet_states', executable='fleetstates_visualizer_node',
                 parameters=[{f'{fleet}_radius': footprint}]),
            Node(package='rmf_visualization_navgraphs', executable='navgraph_visualizer_node',
                 parameters=[{'initial_map_name': s.map_name}]),
            ExecuteProcess(cmd=['rviz2', '-d', LaunchConfiguration('rviz_config').perform(context),
                                '--ros-args', '-r', '/tf:=/tf_relayed',
                                '-r', '/tf_static:=/tf_static_relayed'], output='both'),
        ]
    return out


def generate_launch_description():
    share = get_package_share_directory('m20_rmf')
    return LaunchDescription([
        DeclareLaunchArgument('site', default_value=os.path.join(share, 'sites', 'sim_lab.yaml')),
        DeclareLaunchArgument('robots', default_value='', description='comma list; default all'),
        DeclareLaunchArgument('sim', default_value='false', description='start mock robots'),
        DeclareLaunchArgument('viz', default_value='false', description='RMF visualizers + RViz'),
        DeclareLaunchArgument('rviz_config', default_value=os.path.join(share, 'rviz', 'm20_rmf.rviz')),
        OpaqueFunction(function=_nodes),
    ])
