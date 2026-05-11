from launch import LaunchDescription
from launch_ros.actions import Node


def relay_node(executable, name, in_topic, out_topic, qos_overrides=None):
    params = {'input_topic': in_topic, 'output_topic': out_topic}
    if qos_overrides:
        params.update(qos_overrides)
    return Node(
        package='nav_cmd_bridge',
        executable=executable,
        name=name,
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
    ('odom_relay',         'lio_odom_relay',          '/LIO_ODOM',   '/LIO_ODOM_relayed',   None),

    # sensor_msgs/PointCloud2
    ('pointcloud_relay',   'aligned_points_relay',    '/ALIGNED_POINTS',        '/ALIGNED_POINTS_relayed',        None),
    ('pointcloud_relay',   'full_cloud_map_relay',    '/FULL_CLOUD_MAP',        '/FULL_CLOUD_MAP_relayed',        None),
    ('pointcloud_relay',   'handler_points_relay',    '/HANDLER_POINTS_DEBUG',  '/HANDLER_POINTS_DEBUG_relayed',  None),
    ('pointcloud_relay',   'lidar_points_relay',      '/LIDAR/POINTS',          '/LIDAR_POINTS_relayed',          None),
    ('pointcloud_relay',   'lidar_points2_relay',     '/LIDAR/POINTS2',         '/LIDAR_POINTS2_relayed',         None),
    ('pointcloud_relay',   'loc_body_points_relay',   '/LOC_BODY_POINTS',       '/LOC_BODY_POINTS_relayed',       None),
    ('pointcloud_relay',   'nav_points_relay',        '/NAV_POINTS',            '/NAV_POINTS_relayed',            None),
    ('pointcloud_relay',   'cloud_nav_relay',         '/cloud_nav',             '/cloud_nav_relayed',             None),
    ('pointcloud_relay',   'free_paths_relay',        '/free_paths',            '/free_paths_relayed',            None),
    ('pointcloud_relay',   'local_scans_relay',       '/local_scans',           '/local_scans_relayed',           None),

    # nav_msgs/OccupancyGrid (latched: reliable+transient_local already default)
    ('occupancygrid_relay','grid_map_relay',          '/GRID_MAP',              '/GRID_MAP_relayed',              None),

    # geometry_msgs/PoseStamped
    ('posestamped_relay',  'goal_relay',              '/GOAL',                       '/GOAL_relayed',                       None),
    ('posestamped_relay',  'target_goal_relay',       '/target_goal',                '/target_goal_relayed',                None),
    ('posestamped_relay',  'target_goal_bl_relay',    '/target_goal_baselink',       '/target_goal_baselink_relayed',       None),
    ('posestamped_relay',  'apriltag_pose_relay',     '/pose_in_apriltag_corrected', '/pose_in_apriltag_corrected_relayed', None),

    # geometry_msgs/PoseWithCovarianceStamped
    ('posewithcov_relay',  'initialpose_relay',       '/initialpose',           '/initialpose_relayed',           None),

    # geometry_msgs/PointStamped
    ('pointstamped_relay', 'clicked_point_relay',     '/clicked_point',         '/clicked_point_relayed',         None),

    # sensor_msgs/Imu
    ('imu_relay',          'imu_yesense_relay',       '/IMU_YESENSE',           '/IMU_YESENSE_relayed',           None),
    ('imu_relay',          'lidar_imu201_relay',      '/LIDAR/IMU201',          '/LIDAR_IMU201_relayed',          None),
    ('imu_relay',          'lidar_imu202_relay',      '/LIDAR/IMU202',          '/LIDAR_IMU202_relayed',          None),

    # nav_msgs/Path
    ('path_relay',         'track_path_relay',        '/TRACK_PATH',            '/TRACK_PATH_relayed',            None),
    ('path_relay',         'path_relay',              '/path',                  '/path_relayed',                  None),
    ('path_relay',         'path_astar_relay',        '/path_Astar',            '/path_Astar_relayed',            None),
    ('path_relay',         'track_path_bl_relay',     '/track_path_baselink',   '/track_path_baselink_relayed',   None),

    # std_msgs/Float64MultiArray
    ('float64multiarray_relay', 'matching_error_relay', '/LOCATION_STATUS/MATCHING_ERROR', '/LOCATION_STATUS_MATCHING_ERROR_relayed', None),
    ('float64multiarray_relay', 'weight_items_relay',   '/WEIGHT_ITEMS',                   '/WEIGHT_ITEMS_relayed',                   None),

    # laptop -> AOS: laptop publishes /goal_pose_relayed; this relay renames to /goal_pose
    # which nav_bridge_node already subscribes to.
    ('posestamped_relay',  'goal_pose_relay',         '/goal_pose_relayed',     '/goal_pose',                     None),
]


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
    return LaunchDescription([relay_node(*entry) for entry in RELAYS])
