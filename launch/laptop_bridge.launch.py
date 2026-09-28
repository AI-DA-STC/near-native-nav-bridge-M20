"""Laptop-side domain bridge: robots' relays (domain 0) <-> Open-RMF domain (20).

Run in the Foxy devcontainer on the laptop. The robots stay exactly as they are: their
relays publish /<TOPIC>_relayed_<id> on domain 0. This launch starts one Foxy relay per
topic that reads it on the robots' domain and republishes it, same name, on the RMF
domain (and the reverse for commands), so Open-RMF and our tools never join domain 0
and nothing is installed on the robots.

    ros2 launch nav_cmd_bridge laptop_bridge.launch.py [robots:=834,741] [clouds:=true]

Settings (robots, both domains, the laptop DDS profile) come from m20_stack.yaml at the
repo root, so nothing needs exporting; launch arguments override them.

Only Foxy talks to the robots' Foxy relays. The Jazzy RMF side meets only this bridge's
domain-20 participants, and its own profile (rmf/fastdds_jazzy.xml) keeps Jazzy's
incompatible ros_discovery_info away from them.
"""

import os

import yaml
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


STACK_CANDIDATES = ('/root/ros2_ws/src/nav_cmd_bridge/m20_stack.yaml', '/repo/m20_stack.yaml')


def _stack(path):
    """m20_stack.yaml as a dict (paths made absolute); {} if not found."""
    for p in ([path] if path else []) + [os.environ.get('M20_STACK', '')] + list(STACK_CANDIDATES):
        if p and os.path.exists(p):
            with open(p) as f:
                cfg = yaml.safe_load(f) or {}
            base = os.path.dirname(os.path.abspath(p))
            prof = cfg.get('laptop_profile')
            if prof and not os.path.isabs(prof):
                cfg['laptop_profile'] = os.path.join(base, prof)
            return cfg
    return {}


def _bridge(executable, topic, direction, extra, robots_domain, rmf_domain, profile):
    src, dst = (robots_domain, rmf_domain) if direction == 'up' else (rmf_domain, robots_domain)
    params = {'input_topic': topic, 'output_topic': topic, 'output_domain': int(dst)}
    if extra:
        params.update(extra)
    name = 'bridge' + topic.replace('/', '_').lower()
    env = {'ROS_DOMAIN_ID': str(src)}
    if profile:
        env['FASTRTPS_DEFAULT_PROFILES_FILE'] = profile
    return Node(package='nav_cmd_bridge', executable=executable, name=name,
                output='screen', parameters=[params], additional_env=env)


def _nodes(context):
    def arg(name):
        return LaunchConfiguration(name).perform(context)
    cfg = _stack(arg('stack'))
    robots = [r for r in (arg('robots') or ','.join(str(x) for x in cfg.get('robots', []))).split(',') if r]
    if not robots:
        raise RuntimeError('no robots: set robots: in m20_stack.yaml or pass robots:=834')
    robots_domain = arg('robots_domain') or str(cfg.get('robots_domain', 0))
    rmf_domain = arg('rmf_domain') or str(cfg.get('rmf_domain', 20))
    if robots_domain == rmf_domain:
        raise RuntimeError('robots_domain and rmf_domain must differ')
    clouds = (arg('clouds') or str(cfg.get('bridge_clouds', False))).lower() == 'true'
    profile = arg('profile') or cfg.get('laptop_profile') or os.environ.get('FASTRTPS_DEFAULT_PROFILES_FILE', '')
    if profile and not os.path.exists(profile):
        raise RuntimeError(f'DDS profile {profile} not found')
    print(f'[laptop_bridge] robots {robots}, domain {robots_domain} -> {rmf_domain}, '
          f'profile {profile or "(Fast DDS default)"}, clouds {clouds}')
    out = [_bridge(*e, robots_domain, rmf_domain, profile) for e in SHARED]
    for rid in robots:
        for exe, topic, direction, extra in PER_ROBOT + (CLOUDS if clouds else []):
            out.append(_bridge(exe, f'{topic}_{rid}', direction, extra, robots_domain,
                               rmf_domain, profile))
    return out


def generate_launch_description():
    return LaunchDescription([
        DeclareLaunchArgument('stack', default_value='', description='m20_stack.yaml path'),
        DeclareLaunchArgument('robots', default_value='', description='comma list, e.g. 834,741'),
        DeclareLaunchArgument('robots_domain', default_value=''),
        DeclareLaunchArgument('rmf_domain', default_value=''),
        DeclareLaunchArgument('profile', default_value='', description='laptop DDS profile'),
        DeclareLaunchArgument('clouds', default_value='',
                              description='also bridge /ALIGNED_POINTS_relayed_<id> (heavy)'),
        OpaqueFunction(function=_nodes),
    ])
