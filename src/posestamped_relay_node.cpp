#include <rclcpp/rclcpp.hpp>
#include <geometry_msgs/msg/pose_stamped.hpp>

class PoseStampedRelay : public rclcpp::Node
{
public:
  PoseStampedRelay() : Node("posestamped_relay")
  {
    const std::string in_topic  = declare_parameter<std::string>("input_topic",  "/goal_pose_relayed");
    const std::string out_topic = declare_parameter<std::string>("output_topic", "/goal_pose");

    rclcpp::QoS qos(rclcpp::KeepLast(10));
    qos.reliable().durability_volatile();

    pub_ = create_publisher<geometry_msgs::msg::PoseStamped>(out_topic, qos);
    sub_ = create_subscription<geometry_msgs::msg::PoseStamped>(
      in_topic, qos,
      [this](geometry_msgs::msg::PoseStamped::SharedPtr msg) { pub_->publish(*msg); });

    RCLCPP_INFO(get_logger(), "Relaying %s -> %s", in_topic.c_str(), out_topic.c_str());
  }

private:
  rclcpp::Subscription<geometry_msgs::msg::PoseStamped>::SharedPtr sub_;
  rclcpp::Publisher<geometry_msgs::msg::PoseStamped>::SharedPtr    pub_;
};

int main(int argc, char ** argv)
{
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<PoseStampedRelay>());
  rclcpp::shutdown();
  return 0;
}
