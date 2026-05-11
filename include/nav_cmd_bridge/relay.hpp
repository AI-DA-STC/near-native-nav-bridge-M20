#ifndef NAV_CMD_BRIDGE__RELAY_HPP_
#define NAV_CMD_BRIDGE__RELAY_HPP_

#include <memory>
#include <stdexcept>
#include <string>

#include <rclcpp/rclcpp.hpp>

namespace nav_cmd_bridge
{

inline rclcpp::QoS qos_from_params(
  rclcpp::Node * node,
  const std::string & default_reliability = "reliable",
  const std::string & default_durability = "volatile",
  int default_depth = 10)
{
  const auto reliability = node->declare_parameter<std::string>("reliability", default_reliability);
  const auto durability  = node->declare_parameter<std::string>("durability",  default_durability);
  const auto depth       = node->declare_parameter<int>("depth", default_depth);

  rclcpp::QoS qos{rclcpp::KeepLast(static_cast<size_t>(depth))};
  if (reliability == "best_effort") qos.best_effort(); else qos.reliable();
  if (durability  == "transient_local") qos.transient_local(); else qos.durability_volatile();
  return qos;
}

// Subscribes to <input_topic> and republishes verbatim on <output_topic>.
// Both topic names and QoS are read from ROS parameters.
template <typename MsgT>
class Relay : public rclcpp::Node
{
public:
  explicit Relay(
    const std::string & node_name = "relay",
    const std::string & default_reliability = "reliable",
    const std::string & default_durability  = "volatile")
  : rclcpp::Node(node_name)
  {
    const auto in_topic  = declare_parameter<std::string>("input_topic",  "");
    const auto out_topic = declare_parameter<std::string>("output_topic", "");
    if (in_topic.empty() || out_topic.empty()) {
      RCLCPP_FATAL(get_logger(), "input_topic and output_topic must be set");
      throw std::runtime_error("missing relay params");
    }
    const auto qos = qos_from_params(this, default_reliability, default_durability);

    pub_ = create_publisher<MsgT>(out_topic, qos);
    sub_ = create_subscription<MsgT>(
      in_topic, qos,
      [this](typename MsgT::SharedPtr msg) { pub_->publish(*msg); });

    RCLCPP_INFO(get_logger(), "Relay: %s -> %s", in_topic.c_str(), out_topic.c_str());
  }

private:
  typename rclcpp::Subscription<MsgT>::SharedPtr sub_;
  typename rclcpp::Publisher<MsgT>::SharedPtr    pub_;
};

}  // namespace nav_cmd_bridge

#endif  // NAV_CMD_BRIDGE__RELAY_HPP_
