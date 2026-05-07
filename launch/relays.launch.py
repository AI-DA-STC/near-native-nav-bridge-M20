from launch import LaunchDescription
from launch_ros.actions import Node


# AOS -> laptop: subscribe to bare-DDS topic on AOS, republish as <topic>_relayed
# so the laptop can echo it without needing the bare-DDS type info.
# /parameter_events and /rosout are ROS internals — do not relay.
RELAY_TOPICS = [
    '/ALIGNED_POINTS',
    '/BATTERY_CHARGE_ENABLE',
    '/BATTERY_DATA',
    '/CANCEL_NAV',
    '/CHARGE_CMD',
    '/CHARGE_STATUS',
    '/CONTROL_USAGE_MODE_MASTER',
    '/CONTROL_USAGE_MODE_SLAVE',
    '/CPU_103',
    '/CPU_104',
    '/CPU_106',
    '/FAULT_STATUS',
    '/FULL_CLOUD_MAP',
    '/GAIT',
    '/GOAL',
    '/GPS',
    '/GRID_MAP',
    '/HANDLER_POINTS_DEBUG',
    '/HANDLE_STEER',
    '/HEIGHT_MAP_STATUS',
    '/HES_STATUS',
    '/IMU_DATA',
    '/IMU_DATA_10HZ',
    '/IMU_YESENSE',
    '/JOINTS_DATA_10HZ',
    '/LED/STATUS',
    '/LIDAR/POINTS',
    '/LIDAR/STATUS',
    '/LIO_ODOM',
    '/LOCATION_STATUS',
    '/LOCATION_STATUS/MATCHING_ERROR',
    '/LOC_BODY_POINTS',
    '/MOTION_INFO',
    '/MOTION_STATE',
    '/MOTION_STATUS',
    '/MotionInfo',
    '/NAV_CMD',
    '/NAV_POINTS',
    '/ODOM',
    '/OOA_STATUS',
    '/PLANNER_STATUS',
    '/REAL_STEER',
    '/STEER',
    '/TERRAIN_CLASSIFIER_STATUS',
    '/TRACK_PATH',
    '/WEIGHT_ITEMS',
    '/cloud_nav',
    '/free_paths',
    '/initialpose',
    '/local_scans',
    '/path',
    '/path_Astar',
    '/pose_in_apriltag_corrected',
    '/tag_status',
    '/target_goal',
    '/target_goal_baselink',
    '/tf',
    '/track_path_baselink',
]


def relay_node_name(topic):
    return 'relay_' + topic.strip('/').replace('/', '_')


def generic_relay(in_topic, out_topic):
    return Node(
        package='topic_tools',
        executable='relay',
        name=relay_node_name(in_topic),
        arguments=[in_topic, out_topic],
        output='screen',
    )


def generate_launch_description():
    nodes = [generic_relay(t, t + '_relayed') for t in RELAY_TOPICS]

    # laptop -> AOS: laptop publishes /goal_pose_relayed; this relay republishes
    # as /goal_pose, which nav_bridge_node already subscribes to.
    nodes.append(Node(
        package='nav_cmd_bridge',
        executable='posestamped_relay',
        name='goal_pose_relay',
        output='screen',
        parameters=[{'input_topic': '/goal_pose_relayed', 'output_topic': '/goal_pose'}],
    ))

    return LaunchDescription(nodes)
