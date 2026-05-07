#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/point_cloud2.hpp>

class PointCloudRelay : public rclcpp::Node
{
public:
  PointCloudRelay() : Node("pointcloud_relay")
  {
    const std::string in_topic  = declare_parameter<std::string>("input_topic",  "/ALIGNED_POINTS");
    const std::string out_topic = declare_parameter<std::string>("output_topic", "/ALIGNED_POINTS_relayed");

    rclcpp::QoS qos(rclcpp::KeepLast(5));
    qos.best_effort().durability_volatile();

    pub_ = create_publisher<sensor_msgs::msg::PointCloud2>(out_topic, qos);
    sub_ = create_subscription<sensor_msgs::msg::PointCloud2>(
      in_topic, qos,
      [this](sensor_msgs::msg::PointCloud2::SharedPtr msg) { pub_->publish(*msg); });

    RCLCPP_INFO(get_logger(), "Relaying %s -> %s", in_topic.c_str(), out_topic.c_str());
  }

private:
  rclcpp::Subscription<sensor_msgs::msg::PointCloud2>::SharedPtr sub_;
  rclcpp::Publisher<sensor_msgs::msg::PointCloud2>::SharedPtr    pub_;
};

int main(int argc, char ** argv)
{
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<PointCloudRelay>());
  rclcpp::shutdown();
  return 0;
}
