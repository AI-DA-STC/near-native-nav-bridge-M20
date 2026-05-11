#ifndef NAV_CMD_BRIDGE__RELAY_FIELD_HPP_
#define NAV_CMD_BRIDGE__RELAY_FIELD_HPP_

#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>

#include <rclcpp/rclcpp.hpp>

#include "nav_cmd_bridge/relay.hpp"

namespace nav_cmd_bridge
{

// Subscribes to <input_topic> with type InMsgT and republishes on <output_topic>
// as type OutMsgT, using a user-supplied conversion function.
template <typename InMsgT, typename OutMsgT>
class RelayField : public rclcpp::Node
{
public:
  using Converter = std::function<void(const InMsgT &, OutMsgT &)>;

  RelayField(
    const std::string & node_name,
    Converter convert,
    const std::string & default_reliability = "reliable",
    const std::string & default_durability  = "volatile")
  : rclcpp::Node(node_name), convert_(std::move(convert))
  {
    const auto in_topic  = declare_parameter<std::string>("input_topic",  "");
    const auto out_topic = declare_parameter<std::string>("output_topic", "");
    if (in_topic.empty() || out_topic.empty()) {
      RCLCPP_FATAL(get_logger(), "input_topic and output_topic must be set");
      throw std::runtime_error("missing relay_field params");
    }
    const auto qos = qos_from_params(this, default_reliability, default_durability);

    pub_ = create_publisher<OutMsgT>(out_topic, qos);
    sub_ = create_subscription<InMsgT>(
      in_topic, qos,
      [this](typename InMsgT::SharedPtr in) {
        OutMsgT out;
        convert_(*in, out);
        pub_->publish(out);
      });

    RCLCPP_INFO(get_logger(), "RelayField: %s -> %s", in_topic.c_str(), out_topic.c_str());
  }

private:
  Converter convert_;
  typename rclcpp::Subscription<InMsgT>::SharedPtr sub_;
  typename rclcpp::Publisher<OutMsgT>::SharedPtr   pub_;
};

}  // namespace nav_cmd_bridge

#endif  // NAV_CMD_BRIDGE__RELAY_FIELD_HPP_
