"""Laptop-side domain bridge: robots' relays (domain 0) <-> Open-RMF domain (20).

Run in the Foxy devcontainer on the laptop. The robots stay exactly as they are: their
relays publish /<TOPIC>_relayed_<id> on domain 0. This launch starts one Foxy relay per
topic that reads it on the robots' domain and republishes it, same name, on the RMF
domain (and the reverse for commands), so Open-RMF and our tools never join domain 0
and nothing is installed on the robots.

    export FASTRTPS_DEFAULT_PROFILES_FILE=$PWD/fastdds_profile.xml   # laptop profile
    ros2 launch nav_cmd_bridge laptop_bridge.launch.py robots:=834 [rmf_domain:=20] [clouds:=true]

Only Foxy talks to the robots' Foxy relays. The Jazzy RMF side meets only this bridge's
domain-20 participants, and its own profile (rmf/fastdds_jazzy.xml) keeps Jazzy's
incompatible ros_discovery_info away from them.
"""

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, OpaqueFunction
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node

# (executable, topic, direction, extra params). Topics are the relays' laptop-side names;
# per-robot ones get _<id>. 'up' = robots' domain -> RMF domain, 'down' = the reverse.
SHARED = [
    ('tfmessage_relay', '/tf_relayed', 'up', None),
    ('tfmessage_relay', '/tf_static_relayed', 'up', {'durability': 'transient_local'}),
]
PER_ROBOT = [
    ('odom_relay', '/ODOM_relayed', 'up', None),
    ('occupancygrid_relay', '/GRID_MAP_relayed', 'up', {'durability': 'transient_local'}),
    ('posewithcov_relay', '/initialpose_relayed', 'up', None),
    ('posestamped_relay', '/goal_pose_relayed', 'down', None),
]
CLOUDS = [
    ('pointcloud_relay', '/ALIGNED_POINTS_relayed', 'up', {'reliability': 'best_effort'}),
]


def _bridge(executable, topic, direction, extra, robots_domain, rmf_domain):
    src, dst = (robots_domain, rmf_domain) if direction == 'up' else (rmf_domain, robots_domain)
    params = {'input_topic': topic, 'output_topic': topic, 'output_domain': int(dst)}
    if extra:
        params.update(extra)
    name = 'bridge' + topic.replace('/', '_').lower()
    return Node(package='nav_cmd_bridge', executable=executable, name=name,
                output='screen', parameters=[params],
                additional_env={'ROS_DOMAIN_ID': str(src)})


def _nodes(context):
    robots = [r for r in LaunchConfiguration('robots').perform(context).split(',') if r]
    robots_domain = LaunchConfiguration('robots_domain').perform(context)
    rmf_domain = LaunchConfiguration('rmf_domain').perform(context)
    if robots_domain == rmf_domain:
        raise RuntimeError('robots_domain and rmf_domain must differ')
    clouds = LaunchConfiguration('clouds').perform(context).lower() == 'true'
    out = [_bridge(*e, robots_domain, rmf_domain) for e in SHARED]
    for rid in robots:
        for exe, topic, direction, extra in PER_ROBOT + (CLOUDS if clouds else []):
            out.append(_bridge(exe, f'{topic}_{rid}', direction, extra, robots_domain, rmf_domain))
    return out


def generate_launch_description():
    return LaunchDescription([
        DeclareLaunchArgument('robots', description='comma list of robot ids, e.g. 834,741'),
        DeclareLaunchArgument('robots_domain', default_value='0'),
        DeclareLaunchArgument('rmf_domain', default_value='20'),
        DeclareLaunchArgument('clouds', default_value='false',
                              description='also bridge /ALIGNED_POINTS_relayed_<id> (heavy)'),
        OpaqueFunction(function=_nodes),
    ])
