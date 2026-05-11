#include <memory>

#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/imu.hpp>

#include "nav_cmd_bridge/relay.hpp"

int main(int argc, char ** argv)
{
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<nav_cmd_bridge::Relay<sensor_msgs::msg::Imu>>(
    "imu_relay", "best_effort", "volatile"));
  rclcpp::shutdown();
  return 0;
}
