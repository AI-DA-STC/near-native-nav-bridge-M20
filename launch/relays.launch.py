import os

from launch import LaunchDescription
from launch_ros.actions import Node


# Exported on the robot (e.g. export ROBOT_ID=741) so several robots can share one
# ROS_DOMAIN_ID without colliding. Must be alphanumeric/underscore — it is used raw
# rather than sanitised so that a bad value fails loudly here instead of silently
# disagreeing with the laptop side, which builds the same names from the same value.
# Unset means no suffix, i.e. the original single-robot names.
ROBOT_ID = os.environ.get('ROBOT_ID', '').strip()
SUFFIX = f'_{ROBOT_ID}' if ROBOT_ID else ''


# Only the cross-machine side of each pair gets the suffix, and that side is always
# the one ending in '_relayed'. The other side is a fixed name owned by the robot's
# own AOS stack (/ODOM, /GRID_MAP, /goal_pose ...) and must keep it to stay connected.
def per_robot(topic):
    return topic + SUFFIX if topic.endswith('_relayed') else topic


def relay_node(executable, name, in_topic, out_topic, qos_overrides=None):
    params = {
        'input_topic': per_robot(in_topic),
        'output_topic': per_robot(out_topic),
    }
    if ROBOT_ID and out_topic.endswith('_relayed'):
        params['frame_prefix'] = ROBOT_ID
    if qos_overrides:
        params.update(qos_overrides)
    return Node(
        package='nav_cmd_bridge',
        executable=executable,
        name=name + SUFFIX,
        output='screen',
        parameters=[params],
    )


# Only what the laptop draws (the map, where the robot is) and the two poses it sends. Everything the robots relay
# shares one Wi-Fi: the lidar cloud (/ALIGNED_POINTS), TF and the front camera flooded it, so they stay on the robot.
RELAYS = [
    # AOS -> laptop: subscribe to the AOS topic, republish under <topic>_relayed_<ROBOT_ID>.
    # nav_msgs/Odometry, in the map frame: where the robot is
    ('odom_relay',         'odom_relay',              '/ODOM',                  '/ODOM_relayed',                  None),

    # nav_msgs/OccupancyGrid (latched: reliable+transient_local already default)
    ('occupancygrid_relay','grid_map_relay',          '/GRID_MAP',              '/GRID_MAP_relayed',              None),

    # laptop -> AOS: laptop rviz's "2D Pose Estimate" publishes /initialpose_relayed; this relay
    # renames to /initialpose, which the AOS localizer subscribes to. Laptop-only direction: an
    # AOS -> laptop relay on the same pair would bounce every pose back and forth forever.
    ('posewithcov_relay',  'initialpose_relay',       '/initialpose_relayed',   '/initialpose',                   None),

    # laptop -> AOS: laptop publishes /goal_pose_relayed; this relay renames to /goal_pose
    # which nav_bridge_node already subscribes to.
    ('posestamped_relay',  'goal_pose_relay',         '/goal_pose_relayed',     '/goal_pose',                     None),
]


def generate_launch_description():
    return LaunchDescription([relay_node(*entry) for entry in RELAYS])
