#include <rclcpp/rclcpp.hpp>
#include <nav_msgs/msg/odometry.hpp>

class OdomRelay : public rclcpp::Node
{
public:
  OdomRelay() : Node("odom_relay")
  {
    const std::string in_topic  = declare_parameter<std::string>("input_topic",  "/ODOM");
    const std::string out_topic = declare_parameter<std::string>("output_topic", "/ODOM_relayed");

    rclcpp::QoS sub_qos(rclcpp::KeepLast(10));
    sub_qos.reliable().durability_volatile();

    rclcpp::QoS pub_qos(rclcpp::KeepLast(10));
    pub_qos.reliable().durability_volatile();

    pub_ = create_publisher<nav_msgs::msg::Odometry>(out_topic, pub_qos);
    sub_ = create_subscription<nav_msgs::msg::Odometry>(
      in_topic, sub_qos,
      [this](nav_msgs::msg::Odometry::SharedPtr msg) { pub_->publish(*msg); });

    RCLCPP_INFO(get_logger(), "Relaying %s -> %s", in_topic.c_str(), out_topic.c_str());
  }

private:
  rclcpp::Subscription<nav_msgs::msg::Odometry>::SharedPtr sub_;
  rclcpp::Publisher<nav_msgs::msg::Odometry>::SharedPtr    pub_;
};

int main(int argc, char ** argv)
{
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<OdomRelay>());
  rclcpp::shutdown();
  return 0;
}
