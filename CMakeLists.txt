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

install(TARGETS
  nav_cmd_bridge
  odom_relay
  pointcloud_relay
  occupancygrid_relay
  posestamped_relay
  DESTINATION lib/${PROJECT_NAME}
)

install(PROGRAMS scripts/benchmark.py
  DESTINATION lib/${PROJECT_NAME}
)

install(DIRECTORY launch
  DESTINATION share/${PROJECT_NAME}
)

ament_package()
