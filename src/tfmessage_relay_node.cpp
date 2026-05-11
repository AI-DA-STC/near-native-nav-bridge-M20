#include <memory>

#include <rclcpp/rclcpp.hpp>
#include <tf2_msgs/msg/tf_message.hpp>

#include "nav_cmd_bridge/relay.hpp"

int main(int argc, char ** argv)
{
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<nav_cmd_bridge::Relay<tf2_msgs::msg::TFMessage>>(
    "tfmessage_relay"));
  rclcpp::shutdown();
  return 0;
}
