#include <memory>

#include <geometry_msgs/msg/point_stamped.hpp>
#include <rclcpp/rclcpp.hpp>

#include "nav_cmd_bridge/relay.hpp"

int main(int argc, char ** argv)
{
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<nav_cmd_bridge::Relay<geometry_msgs::msg::PointStamped>>(
    "pointstamped_relay"));
  rclcpp::shutdown();
  return 0;
}
