#include <memory>

#include <geometry_msgs/msg/pose_stamped.hpp>
#include <nav_msgs/msg/odometry.hpp>
#include <rclcpp/rclcpp.hpp>

#include "nav_cmd_bridge/relay_field.hpp"

// Example RelayField: nav_msgs/Odometry  ->  geometry_msgs/PoseStamped
// Extracts the pose+header from the Odometry message and republishes.
int main(int argc, char ** argv)
{
  rclcpp::init(argc, argv);

  auto convert = [](const nav_msgs::msg::Odometry & in,
                    geometry_msgs::msg::PoseStamped & out) {
    out.header = in.header;
    out.pose   = in.pose.pose;
  };

  rclcpp::spin(std::make_shared<nav_cmd_bridge::RelayField<
      nav_msgs::msg::Odometry, geometry_msgs::msg::PoseStamped>>(
    "odom_to_pose_relay_field", convert));

  rclcpp::shutdown();
  return 0;
}
