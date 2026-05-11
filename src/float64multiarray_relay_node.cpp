#include <memory>

#include <rclcpp/rclcpp.hpp>
#include <std_msgs/msg/float64_multi_array.hpp>

#include "nav_cmd_bridge/relay.hpp"

int main(int argc, char ** argv)
{
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<nav_cmd_bridge::Relay<std_msgs::msg::Float64MultiArray>>(
    "float64multiarray_relay"));
  rclcpp::shutdown();
  return 0;
}
