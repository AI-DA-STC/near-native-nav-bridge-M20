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
SHARED_TOPICS = ('/tf_relayed', '/tf_static_relayed')


# Only the cross-machine side of each pair gets the suffix, and that side is always
# the one ending in '_relayed'. The other side is a fixed name owned by the robot's
# own AOS stack (/ODOM, /tf, /goal_pose ...) and must keep it to stay connected.
def per_robot(topic):
    return topic + SUFFIX if topic.endswith('_relayed') and topic not in SHARED_TOPICS else topic


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


# AOS -> laptop: subscribe to AOS topic, republish under <topic>_relayed.
# drdds/msg/* custom types are skipped — laptop docker doesn't have those defs.
RELAYS = [
    # tf2_msgs/TFMessage  --  /tf_static is latched: needs transient_local QoS
    ('tfmessage_relay',    'tf_relay',                '/tf',         '/tf_relayed',         None),
    ('tfmessage_relay',    'tf_static_relay',         '/tf_static',  '/tf_static_relayed',
        {'durability': 'transient_local'}),

    # nav_msgs/Odometry
    ('odom_relay',         'odom_relay',              '/ODOM',       '/ODOM_relayed',       None),

    # sensor_msgs/PointCloud2
    ('pointcloud_relay',   'aligned_points_relay',    '/ALIGNED_POINTS',        '/ALIGNED_POINTS_relayed',        None),

    # nav_msgs/OccupancyGrid (latched: reliable+transient_local already default)
    ('occupancygrid_relay','grid_map_relay',          '/GRID_MAP',              '/GRID_MAP_relayed',              None),

    # geometry_msgs/PoseWithCovarianceStamped
    ('posewithcov_relay',  'initialpose_relay',       '/initialpose',           '/initialpose_relayed',           None),

    # laptop -> AOS: laptop publishes /goal_pose_relayed; this relay renames to /goal_pose
    # which nav_bridge_node already subscribes to.
    ('posestamped_relay',  'goal_pose_relay',         '/goal_pose_relayed',     '/goal_pose',                     None),
]

def generate_launch_description():
    return LaunchDescription([relay_node(*entry) for entry in RELAYS])
