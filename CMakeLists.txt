cmake_minimum_required(VERSION 3.5)
project(nav_cmd_bridge)

# ROS 2 Foxy – C++14
if(NOT CMAKE_CXX_STANDARD)
  set(CMAKE_CXX_STANDARD 14)
endif()

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

find_package(ament_cmake REQUIRED)
find_package(rclcpp REQUIRED)
find_package(geometry_msgs REQUIRED)
find_package(nav_msgs REQUIRED)
find_package(sensor_msgs REQUIRED)
find_package(std_msgs REQUIRED)
find_package(tf2_msgs REQUIRED)

include_directories(include)

add_executable(nav_cmd_bridge src/nav_bridge_node.cpp)
ament_target_dependencies(nav_cmd_bridge
  rclcpp
  geometry_msgs
  nav_msgs
)

add_executable(odom_relay src/odom_relay_node.cpp)
ament_target_dependencies(odom_relay rclcpp nav_msgs)

add_executable(pointcloud_relay src/pointcloud_relay_node.cpp)
ament_target_dependencies(pointcloud_relay rclcpp sensor_msgs)

add_executable(occupancygrid_relay src/occupancygrid_relay_node.cpp)
ament_target_dependencies(occupancygrid_relay rclcpp nav_msgs)

add_executable(posestamped_relay src/posestamped_relay_node.cpp)
ament_target_dependencies(posestamped_relay rclcpp geometry_msgs)

add_executable(odom_to_pose_relay_field src/odom_to_pose_relay_field_node.cpp)
ament_target_dependencies(odom_to_pose_relay_field rclcpp nav_msgs geometry_msgs)

add_executable(tfmessage_relay src/tfmessage_relay_node.cpp)
ament_target_dependencies(tfmessage_relay rclcpp tf2_msgs)

add_executable(path_relay src/path_relay_node.cpp)
ament_target_dependencies(path_relay rclcpp nav_msgs)

add_executable(imu_relay src/imu_relay_node.cpp)
ament_target_dependencies(imu_relay rclcpp sensor_msgs)

add_executable(posewithcov_relay src/posewithcov_relay_node.cpp)
ament_target_dependencies(posewithcov_relay rclcpp geometry_msgs)

add_executable(pointstamped_relay src/pointstamped_relay_node.cpp)
ament_target_dependencies(pointstamped_relay rclcpp geometry_msgs)

add_executable(float64multiarray_relay src/float64multiarray_relay_node.cpp)
ament_target_dependencies(float64multiarray_relay rclcpp std_msgs)

install(TARGETS
  nav_cmd_bridge
  odom_relay
  pointcloud_relay
  occupancygrid_relay
  posestamped_relay
  odom_to_pose_relay_field
  tfmessage_relay
  path_relay
  imu_relay
  posewithcov_relay
  pointstamped_relay
  float64multiarray_relay
  DESTINATION lib/${PROJECT_NAME}
)

install(DIRECTORY include/
  DESTINATION include/
)

install(PROGRAMS scripts/benchmark.py
  DESTINATION lib/${PROJECT_NAME}
)

install(DIRECTORY launch
  DESTINATION share/${PROJECT_NAME}
)

ament_package()
