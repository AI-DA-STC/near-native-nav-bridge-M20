#include <memory>

#include <nav_msgs/msg/occupancy_grid.hpp>
#include <rclcpp/rclcpp.hpp>

#include "nav_cmd_bridge/relay.hpp"

int main(int argc, char ** argv)
{
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<nav_cmd_bridge::Relay<nav_msgs::msg::OccupancyGrid>>(
    "occupancygrid_relay", "reliable", "transient_local"));
  rclcpp::shutdown();
  return 0;
}
