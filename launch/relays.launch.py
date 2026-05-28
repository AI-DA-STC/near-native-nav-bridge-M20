"""
Robot-side relay launch. Run on each DeepRobotics M20.

Subscribes to the robot's AOS-native (DDS) topics and republishes them under
/<robot_name>/<topic>_relayed for the laptop to consume over the shared
discovery domain.

The TFMessage relay rewrites frame_ids so all robots share a single "map"
frame but have their own "<robot_name>/odom" and "<robot_name>/base_link":
    map -> robot_741/odom -> robot_741/base_link
    map -> robot_738/odom -> robot_738/base_link

Usage:
    ros2 launch nav_cmd_bridge relays.launch.py robot_name:=robot_741
"""
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, OpaqueFunction
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


# (executable, name, native_topic, relayed_topic_basename, qos_overrides)
# native_topic   — absolute path on the robot's DDS bus (AOS-native).
# relayed_topic_basename — published under /<robot_name>/<basename>; relative so
#                          the node's namespace prepends automatically.
# drdds/msg/* custom types are skipped — laptop docker doesn't have those defs.
RELAYS = [
    # nav_msgs/Odometry
    ('odom_relay',         'odom_relay',           '/ODOM',                       'ODOM_relayed',                       None),
    ('odom_relay',         'lio_odom_relay',       '/LIO_ODOM',                   'LIO_ODOM_relayed',                   None),

    # sensor_msgs/PointCloud2
    ('pointcloud_relay',   'aligned_points_relay', '/ALIGNED_POINTS',             'ALIGNED_POINTS_relayed',             None),
    ('pointcloud_relay',   'full_cloud_map_relay', '/FULL_CLOUD_MAP',             'FULL_CLOUD_MAP_relayed',             None),
    ('pointcloud_relay',   'handler_points_relay', '/HANDLER_POINTS_DEBUG',       'HANDLER_POINTS_DEBUG_relayed',       None),
    ('pointcloud_relay',   'lidar_points_relay',   '/LIDAR/POINTS',               'LIDAR_POINTS_relayed',               None),
    ('pointcloud_relay',   'lidar_points2_relay',  '/LIDAR/POINTS2',              'LIDAR_POINTS2_relayed',              None),
    ('pointcloud_relay',   'loc_body_points_relay','/LOC_BODY_POINTS',            'LOC_BODY_POINTS_relayed',            None),
    ('pointcloud_relay',   'nav_points_relay',     '/NAV_POINTS',                 'NAV_POINTS_relayed',                 None),
    ('pointcloud_relay',   'cloud_nav_relay',      '/cloud_nav',                  'cloud_nav_relayed',                  None),
    ('pointcloud_relay',   'free_paths_relay',     '/free_paths',                 'free_paths_relayed',                 None),
    ('pointcloud_relay',   'local_scans_relay',    '/local_scans',                'local_scans_relayed',                None),

    # nav_msgs/OccupancyGrid (latched: reliable+transient_local already default)
    ('occupancygrid_relay','grid_map_relay',       '/GRID_MAP',                   'GRID_MAP_relayed',                   None),

    # geometry_msgs/PoseStamped
    ('posestamped_relay',  'goal_relay',           '/GOAL',                       'GOAL_relayed',                       None),
    ('posestamped_relay',  'target_goal_relay',    '/target_goal',                'target_goal_relayed',                None),
    ('posestamped_relay',  'target_goal_bl_relay', '/target_goal_baselink',       'target_goal_baselink_relayed',       None),
    ('posestamped_relay',  'apriltag_pose_relay',  '/pose_in_apriltag_corrected', 'pose_in_apriltag_corrected_relayed', None),

    # geometry_msgs/PoseWithCovarianceStamped
    ('posewithcov_relay',  'initialpose_relay',    '/initialpose',                'initialpose_relayed',                None),

    # geometry_msgs/PointStamped
    ('pointstamped_relay', 'clicked_point_relay',  '/clicked_point',              'clicked_point_relayed',              None),

    # sensor_msgs/Imu
    ('imu_relay',          'imu_yesense_relay',    '/IMU_YESENSE',                'IMU_YESENSE_relayed',                None),
    ('imu_relay',          'lidar_imu201_relay',   '/LIDAR/IMU201',               'LIDAR_IMU201_relayed',               None),
    ('imu_relay',          'lidar_imu202_relay',   '/LIDAR/IMU202',               'LIDAR_IMU202_relayed',               None),

    # nav_msgs/Path
    ('path_relay',         'track_path_relay',     '/TRACK_PATH',                 'TRACK_PATH_relayed',                 None),
    ('path_relay',         'path_relay',           '/path',                       'path_relayed',                       None),
    ('path_relay',         'path_astar_relay',     '/path_Astar',                 'path_Astar_relayed',                 None),
    ('path_relay',         'track_path_bl_relay',  '/track_path_baselink',        'track_path_baselink_relayed',        None),

    # std_msgs/Float64MultiArray
    ('float64multiarray_relay', 'matching_error_relay', '/LOCATION_STATUS/MATCHING_ERROR', 'LOCATION_STATUS_MATCHING_ERROR_relayed', None),
    ('float64multiarray_relay', 'weight_items_relay',   '/WEIGHT_ITEMS',                   'WEIGHT_ITEMS_relayed',                   None),
]


def _launch(context, *args, **kwargs):
    robot_name = context.perform_substitution(LaunchConfiguration("robot_name"))
    if not robot_name:
        raise RuntimeError("robot_name launch arg is required")

    nodes = []

    # Verbatim relays: namespace prepends /<robot_name>/ to the relative output_topic.
    for executable, name, in_topic, out_basename, qos_overrides in RELAYS:
        params = {'input_topic': in_topic, 'output_topic': out_basename}
        if qos_overrides:
            params.update(qos_overrides)
        nodes.append(Node(
            package='nav_cmd_bridge',
            executable=executable,
            namespace=robot_name,
            name=name,
            output='screen',
            parameters=[params],
        ))

    # TF relays: rewrite frame_ids (map stays shared, others get <robot_name>/ prefix).
    # /tf is volatile; /tf_static is transient_local.
    nodes.append(Node(
        package='nav_cmd_bridge',
        executable='tfmessage_prefix_relay',
        namespace=robot_name,
        name='tf_relay',
        output='screen',
        parameters=[{
            'input_topic':  '/tf',
            'output_topic': 'tf_relayed',
            'robot_name':   robot_name,
            'shared_frames': ['map'],
        }],
    ))
    nodes.append(Node(
        package='nav_cmd_bridge',
        executable='tfmessage_prefix_relay',
        namespace=robot_name,
        name='tf_static_relay',
        output='screen',
        parameters=[{
            'input_topic':  '/tf_static',
            'output_topic': 'tf_static_relayed',
            'robot_name':   robot_name,
            'shared_frames': ['map'],
            'durability':   'transient_local',
        }],
    ))

    # laptop -> AOS: laptop publishes /<robot_name>/goal_pose_relayed;
    # this relay renames to /goal_pose locally on the robot for AOS consumers.
    nodes.append(Node(
        package='nav_cmd_bridge',
        executable='posestamped_relay',
        namespace=robot_name,
        name='goal_pose_relay',
        output='screen',
        parameters=[{
            'input_topic':  'goal_pose_relayed',   # /<robot_name>/goal_pose_relayed
            'output_topic': '/goal_pose',          # absolute: native robot topic
        }],
    ))

    return nodes


# NOT relayed (drdds/* custom types — laptop has no type definitions):
#   /BATTERY_CHARGE_ENABLE, /BATTERY_DATA, /CANCEL_NAV, /CHARGE_CMD, /CHARGE_STATUS,
#   /CONTROL_USAGE_MODE_*, /CPU_103-106, /FAULT_STATUS, /GAIT, /GPS, /HANDLE_STEER,
#   /HEIGHT_MAP_STATUS, /HES_STATUS, /IMU_DATA, /IMU_DATA_10HZ, /JOINTS_DATA_10HZ,
#   /LED/STATUS, /LIDAR/STATUS, /LOCATION_STATUS, /MOTION_INFO, /MOTION_STATE,
#   /MOTION_STATUS, /MotionInfo, /NAV_CMD, /OOA_STATUS, /PLANNER_STATUS, /REAL_STEER,
#   /STEER, /TERRAIN_CLASSIFIER_STATUS, /tag_status
# To enable these: ship the drdds package's msg definitions into the laptop container,
# build it as a workspace dependency, then add relays for each drdds type.


def generate_launch_description():
    return LaunchDescription([
        DeclareLaunchArgument(
            "robot_name",
            description="Per-robot namespace, e.g. robot_741. All relayed topics "
                        "are published under /<robot_name>/ and tf frames are "
                        "prefixed (except 'map')."),
        OpaqueFunction(function=_launch),
    ])
