#ifndef NAV_CMD_BRIDGE__RELAY_HPP_
#define NAV_CMD_BRIDGE__RELAY_HPP_

#include <algorithm>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

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

struct FramePrefix
{
  std::string prefix;
  std::vector<std::string> shared;

  void operator()(std::string & frame) const
  {
    if (prefix.empty() || frame.empty() ||
      std::find(shared.begin(), shared.end(), frame) != shared.end()) {return;}
    frame = prefix + "/" + frame;
  }
};

template <typename T>
void prefix_frames(T & msg, const FramePrefix & fp);

template <typename T>
auto prefix_header(T & m, const FramePrefix & fp, int) -> decltype(void(m.header)) {fp(m.header.frame_id);}
template <typename T>
void prefix_header(T &, const FramePrefix &, long) {}

template <typename T>
auto prefix_child(T & m, const FramePrefix & fp, int) -> decltype(void(m.child_frame_id)) {fp(m.child_frame_id);}
template <typename T>
void prefix_child(T &, const FramePrefix &, long) {}

template <typename T>
auto prefix_transforms(T & m, const FramePrefix & fp, int) -> decltype(void(m.transforms))
{
  for (auto & t : m.transforms) {prefix_frames(t, fp);}
}
template <typename T>
void prefix_transforms(T &, const FramePrefix &, long) {}

template <typename T>
auto prefix_poses(T & m, const FramePrefix & fp, int) -> decltype(void(m.poses))
{
  for (auto & p : m.poses) {prefix_frames(p, fp);}
}
template <typename T>
void prefix_poses(T &, const FramePrefix &, long) {}

template <typename T>
void prefix_frames(T & msg, const FramePrefix & fp)
{
  prefix_header(msg, fp, 0);
  prefix_child(msg, fp, 0);
  prefix_transforms(msg, fp, 0);
  prefix_poses(msg, fp, 0);
}

// Subscribes to <input_topic> and republishes on <output_topic>.
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
    const FramePrefix fp{
      declare_parameter<std::string>("frame_prefix", ""),
      declare_parameter<std::vector<std::string>>("shared_frames", {"map"})};

    pub_ = create_publisher<MsgT>(out_topic, qos);
    sub_ = create_subscription<MsgT>(
      in_topic, qos,
      [this, fp](typename MsgT::SharedPtr msg) {
        prefix_frames(*msg, fp);
        pub_->publish(*msg);
      });

    RCLCPP_INFO(get_logger(), "Relay: %s -> %s", in_topic.c_str(), out_topic.c_str());
  }

private:
  typename rclcpp::Subscription<MsgT>::SharedPtr sub_;
  typename rclcpp::Publisher<MsgT>::SharedPtr    pub_;
};

}  // namespace nav_cmd_bridge

#endif  // NAV_CMD_BRIDGE__RELAY_HPP_
