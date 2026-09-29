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
    allow = LaunchConfiguration('allow_robot_domain').perform(context).lower() == 'true'
    if os.environ.get('ROS_DOMAIN_ID', '0') in ('', '0') and not allow:
        # Every node here is a Jazzy participant; on the robots' domain they crash the
        # Foxy relays (see m20_rmf/domain_guard.py).
        raise RuntimeError('ROS_DOMAIN_ID is 0, the robots\' domain: Jazzy nodes there crash '
                           'the Foxy relays. export ROS_DOMAIN_ID=10 (or allow_robot_domain:=true).')
    from m20_rmf import stack
    cfg = stack.load()
    site = stack.path(LaunchConfiguration('site').perform(context)) or cfg.get('site') or \
        os.path.join(get_package_share_directory('m20_rmf'), 'sites', 'sim_lab.yaml')
    robots = LaunchConfiguration('robots').perform(context) or \
        ','.join(stack.robots_for(site, cfg) or [])
    from m20_rmf.sitefile import Site
    s = Site.load(site)     # fail fast on a bad site file, before anything starts
    fleet = s.fleet['name']
    footprint = float(s.fleet['profile']['footprint'])
    port = LaunchConfiguration('monitor_port').perform(context)
    ws = f'ws://localhost:{port}'
    guard = ['--allow-robot-domain'] if allow else []
    out = [
        # Monitor first: the dispatcher and adapter connect to its websocket on start.
        Node(package='m20_rmf', executable='monitor', output='both',
             arguments=['--port', port] + guard),
        Node(package='rmf_traffic_ros2', executable='rmf_traffic_schedule', output='both'),
        Node(package='rmf_traffic_ros2', executable='rmf_traffic_blockade', output='both'),
        Node(package='rmf_task_ros2', executable='rmf_task_dispatcher', output='both',
             parameters=[{'bidding_time_window': 2.0, 'server_uri': ws}]),
        Node(package='m20_rmf', executable='fleet_adapter', output='both',
             arguments=['--site', site, '--robots', robots, '--server-uri', ws] + guard),
    ]
    if LaunchConfiguration('sim').perform(context).lower() == 'true':
        out.append(Node(package='m20_rmf', executable='mock_robot', output='both',
                        arguments=['--site', site, '--robots', robots] + guard))
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
        DeclareLaunchArgument('site', default_value='',
                              description='site YAML; default: site: in m20_stack.yaml'),
        DeclareLaunchArgument('robots', default_value='',
                              description='comma list; default: robots: in m20_stack.yaml when using its site, else all robots of the site'),
        DeclareLaunchArgument('sim', default_value='false', description='start mock robots'),
        DeclareLaunchArgument('viz', default_value='false', description='RMF visualizers + RViz'),
        DeclareLaunchArgument('monitor_port', default_value='7878',
                              description='task-state websocket; change it to run a mock '
                                          'rehearsal next to the live stack'),
        DeclareLaunchArgument('allow_robot_domain', default_value='false',
                              description='permit ROS_DOMAIN_ID=0 (only if no Foxy relay can see us)'),
        DeclareLaunchArgument('rviz_config', default_value=os.path.join(share, 'rviz', 'm20_rmf.rviz')),
        OpaqueFunction(function=_nodes),
    ])
