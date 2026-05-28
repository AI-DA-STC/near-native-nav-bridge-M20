#include <algorithm>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include <rclcpp/rclcpp.hpp>
#include <tf2_msgs/msg/tf_message.hpp>

#include "nav_cmd_bridge/relay.hpp"

namespace nav_cmd_bridge
{

// TFMessage relay that prefixes frame_ids with <robot_name>/ before republishing,
// except for frames listed in `shared_frames` (default: "map") which are left as-is.
// Used on the robot side so that the laptop sees disambiguated frames per robot:
//   map -> robot_741/odom -> robot_741/base_link
class TFMessagePrefixRelay : public rclcpp::Node
{
public:
  TFMessagePrefixRelay() : rclcpp::Node("tfmessage_prefix_relay")
  {
    const auto in_topic     = declare_parameter<std::string>("input_topic",  "");
    const auto out_topic    = declare_parameter<std::string>("output_topic", "");
    const auto robot_name   = declare_parameter<std::string>("robot_name",   "");
    shared_frames_          = declare_parameter<std::vector<std::string>>(
                                "shared_frames", std::vector<std::string>{"map"});

    if (in_topic.empty() || out_topic.empty() || robot_name.empty()) {
      RCLCPP_FATAL(get_logger(),
                   "input_topic, output_topic, and robot_name must be set");
      throw std::runtime_error("missing tfmessage_prefix_relay params");
    }
    prefix_ = robot_name + "/";

    const auto qos = qos_from_params(this);
    pub_ = create_publisher<tf2_msgs::msg::TFMessage>(out_topic, qos);
    sub_ = create_subscription<tf2_msgs::msg::TFMessage>(
      in_topic, qos,
      [this](tf2_msgs::msg::TFMessage::SharedPtr msg) {
        for (auto & tfs : msg->transforms) {
          tfs.header.frame_id  = rewrite(tfs.header.frame_id);
          tfs.child_frame_id   = rewrite(tfs.child_frame_id);
        }
        pub_->publish(*msg);
      });

    RCLCPP_INFO(get_logger(), "TFMessagePrefixRelay: %s -> %s (prefix=\"%s\")",
                in_topic.c_str(), out_topic.c_str(), prefix_.c_str());
  }

private:
  std::string rewrite(const std::string & frame) const
  {
    if (frame.empty()) return frame;
    if (std::find(shared_frames_.begin(), shared_frames_.end(), frame) != shared_frames_.end())
      return frame;
    if (frame.rfind(prefix_, 0) == 0) return frame;
    return prefix_ + frame;
  }

  std::string prefix_;
  std::vector<std::string> shared_frames_;
  rclcpp::Subscription<tf2_msgs::msg::TFMessage>::SharedPtr sub_;
  rclcpp::Publisher<tf2_msgs::msg::TFMessage>::SharedPtr pub_;
};

}  // namespace nav_cmd_bridge

int main(int argc, char ** argv)
{
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<nav_cmd_bridge::TFMessagePrefixRelay>());
  rclcpp::shutdown();
  return 0;
}
