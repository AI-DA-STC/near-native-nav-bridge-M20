#ifndef NAV_CMD_BRIDGE__RELAY_HPP_
#define NAV_CMD_BRIDGE__RELAY_HPP_

#include <algorithm>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include <rcl/init_options.h>
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

// A node on another DDS domain: its own context, spun on a private thread.
//
// Lets one relay read the robot's internal domain (0, fixed by DeepRobotics) and
// publish on a separate laptop domain, so relayed topics never mix with other
// robots or other people's domain-0 traffic. Foxy has no public API for this: the
// domain is set on the context's rcl init options and on the node's cached rcl
// node options (which rclcpp otherwise fills from ROS_DOMAIN_ID).
class DomainNode
{
public:
  DomainNode(const std::string & name, size_t domain_id)
  {
    rclcpp::InitOptions init_options;
    init_options.auto_initialize_logging(false);
    if (rcl_init_options_set_domain_id(
        const_cast<rcl_init_options_t *>(init_options.get_rcl_init_options()),
        domain_id) != RCL_RET_OK)
    {
      throw std::runtime_error("could not set domain id " + std::to_string(domain_id));
    }
    context_ = std::make_shared<rclcpp::Context>();
    context_->init(0, nullptr, init_options);

    rclcpp::NodeOptions options;
    options.context(context_);
    options.start_parameter_services(false);
    const_cast<rcl_node_options_t *>(options.get_rcl_node_options())->domain_id = domain_id;
    node_ = std::make_shared<rclcpp::Node>(name, options);

    rclcpp::ExecutorOptions exec_options;
    exec_options.context = context_;
    executor_ = std::make_shared<rclcpp::executors::SingleThreadedExecutor>(exec_options);
    executor_->add_node(node_);
    thread_ = std::thread([this]() {executor_->spin();});
  }

  ~DomainNode()
  {
    context_->shutdown("relay exiting");
    if (thread_.joinable()) {thread_.join();}
  }

  rclcpp::Node::SharedPtr node() const {return node_;}

private:
  rclcpp::Context::SharedPtr context_;
  rclcpp::Node::SharedPtr node_;
  rclcpp::executors::SingleThreadedExecutor::SharedPtr executor_;
  std::thread thread_;
};

// Subscribes to <input_topic> and republishes on <output_topic>.
// The subscription lives on this node's domain (ROS_DOMAIN_ID); if <output_domain>
// is set (>= 0) and differs, the publisher lives on that domain instead.
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

    const auto out_domain = declare_parameter<int>("output_domain", -1);
    if (out_domain >= 0 && static_cast<size_t>(out_domain) != get_domain_id()) {
      out_side_ = std::make_unique<DomainNode>(
        std::string(get_name()) + "_out", static_cast<size_t>(out_domain));
      pub_ = out_side_->node()->create_publisher<MsgT>(out_topic, qos);
    } else {
      pub_ = create_publisher<MsgT>(out_topic, qos);
    }
    sub_ = create_subscription<MsgT>(
      in_topic, qos,
      [this, fp](typename MsgT::SharedPtr msg) {
        prefix_frames(*msg, fp);
        pub_->publish(*msg);
      });

    RCLCPP_INFO(
      get_logger(), "Relay: %s (domain %zu) -> %s (domain %zu)", in_topic.c_str(),
      get_domain_id(), out_topic.c_str(),
      out_side_ ? static_cast<size_t>(out_domain) : get_domain_id());
  }

private:
  size_t get_domain_id()
  {
    size_t id = 0;
    rcl_node_get_domain_id(get_node_base_interface()->get_rcl_node_handle(), &id);
    return id;
  }

  std::unique_ptr<DomainNode> out_side_;   // before pub_: destroyed after it
  typename rclcpp::Subscription<MsgT>::SharedPtr sub_;
  typename rclcpp::Publisher<MsgT>::SharedPtr    pub_;
};

}  // namespace nav_cmd_bridge

#endif  // NAV_CMD_BRIDGE__RELAY_HPP_
