#include <rclcpp/rclcpp.hpp>
#include <nav_msgs/msg/occupancy_grid.hpp>

class OccupancyGridRelay : public rclcpp::Node
{
public:
  OccupancyGridRelay() : Node("occupancygrid_relay")
  {
    const std::string in_topic  = declare_parameter<std::string>("input_topic",  "/GRID_MAP");
    const std::string out_topic = declare_parameter<std::string>("output_topic", "/GRID_MAP_relayed");

    rclcpp::QoS qos(rclcpp::KeepLast(1));
    qos.reliable().transient_local();

    pub_ = create_publisher<nav_msgs::msg::OccupancyGrid>(out_topic, qos);
    sub_ = create_subscription<nav_msgs::msg::OccupancyGrid>(
      in_topic, qos,
      [this](nav_msgs::msg::OccupancyGrid::SharedPtr msg) { pub_->publish(*msg); });

    RCLCPP_INFO(get_logger(), "Relaying %s -> %s", in_topic.c_str(), out_topic.c_str());
  }

private:
  rclcpp::Subscription<nav_msgs::msg::OccupancyGrid>::SharedPtr sub_;
  rclcpp::Publisher<nav_msgs::msg::OccupancyGrid>::SharedPtr    pub_;
};

int main(int argc, char ** argv)
{
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<OccupancyGridRelay>());
  rclcpp::shutdown();
  return 0;
}
