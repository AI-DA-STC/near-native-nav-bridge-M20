#include <arpa/inet.h>
#include <sys/socket.h>
#include <unistd.h>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <set>
#include <string>
#include <vector>
#include <mutex>
#include <thread>

#include "rclcpp/rclcpp.hpp"
#include "geometry_msgs/msg/pose_stamped.hpp"
#include "nav_msgs/msg/odometry.hpp"
#include "std_msgs/msg/string.hpp"
#include "visualization_msgs/msg/marker_array.hpp"

#include "nav_cmd_bridge/nav_bridge.hpp"

struct udpMessage {
    unsigned char header[16];
    unsigned char data[BUFFER_SIZE];
};

static int g_fd;
static struct sockaddr_in g_addr;
static unsigned short g_msg_id = 0;
static double g_cur_x = 0, g_cur_y = 0, g_cur_yaw = 0;
static bool g_pos_valid = false;
static std::mutex g_pos_mutex;
static bool g_replies_tracked = false;

// Latest goal (Type 1003) and mode switch (Type 1101) sent, so that bridge mode's reply
// thread can print what the robot answers against the waypoint it belongs to.
struct Sent {
    int num = 0;               // waypoint number, as in the [WP n/..] lines; 0 = nothing sent yet
    unsigned short id = 0;     // UDP message id
    std::chrono::steady_clock::time_point at;
    bool replied = false;
    bool overdue = false;      // already reported as unanswered
    int error_code = 0;
};
// Plain globals, not a map: detached waypoint threads can still send while the process exits.
static Sent g_sent_goal, g_sent_mode;
static std::mutex g_sent_mutex;
static const double REPLY_TIMEOUT_S = 3.0;  // the robots answer a mode switch within 0.02 s
static const int NAV_BUSY = 0xE008;

static Sent* sentFor(int type) {
    return type == 1003 ? &g_sent_goal : type == 1101 ? &g_sent_mode : nullptr;
}

// Must match the suffix relays.launch.py applies on the robot, so export the same
// ROBOT_ID on both machines. Unset on both sides gives the single-robot name.
static std::string perRobot(const std::string& name) {
    const char* id = std::getenv("ROBOT_ID");
    return (id && *id) ? name + "_" + id : name;
}

static const char* navErrorStr(int c) {
    switch (c) {
        case 0:      return "OK";
        case 0x2300: return "Cancelled";
        case 0x2302: return "Success";
        case 0xA301: return "Abnormal motion state";
        case 0xA302: return "Battery too low";
        case 0xA303: return "Motor overtemperature";
        case 0xA312: return "Nav module comms abnormal";
        case 0xA313: return "Location abnormal";
        case 0xA328: return "Failed to switch nav mode";
        case 0xA341: return "Already executing task";
        case 0xA34B: return "Persistent obstacle stop";
        case 0xA34C: return "Global planning failure";
        case 57351:  return "No operation permission";
        case NAV_BUSY: return "Has nav task, new task refused";
        default:     return "Unknown error";
    }
}

static const char* navStatusStr(int s) {
    switch (s) {
        case 0:    return "Idle";
        case 2:    return "Preprocessing";
        case 3:    return "Navigating";
        case 4:    return "Complete";
        case 0xff: return "Paused";
        default:   return "Unknown";
    }
}

static double quatToYaw(double x, double y, double z, double w) {
    return std::atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z));
}

static void storeOdom(const nav_msgs::msg::Odometry::SharedPtr msg) {
    std::lock_guard<std::mutex> lk(g_pos_mutex);
    g_cur_x   = msg->pose.pose.position.x;
    g_cur_y   = msg->pose.pose.position.y;
    g_cur_yaw = quatToYaw(msg->pose.pose.orientation.x, msg->pose.pose.orientation.y,
                          msg->pose.pose.orientation.z, msg->pose.pose.orientation.w);
    g_pos_valid = true;
}

// Value of the first "key": field in payload, without quotes.
static std::string jsonField(const std::string& payload, const std::string& key) {
    std::string search = "\"" + key + "\":";
    size_t pos = payload.find(search);
    if (pos == std::string::npos) return "";
    pos += search.length();
    while (pos < payload.size() && (payload[pos] == ' ' || payload[pos] == '"')) pos++;
    size_t end = pos;
    while (end < payload.size() && payload[end] != ',' && payload[end] != '}' && payload[end] != '"') end++;
    return payload.substr(pos, end - pos);
}

static double secondsSince(std::chrono::steady_clock::time_point t) {
    return std::chrono::duration<double>(std::chrono::steady_clock::now() - t).count();
}

static void trackSent(int type, int num, unsigned short id) {
    std::lock_guard<std::mutex> lk(g_sent_mutex);
    Sent* last = sentFor(type);
    if (!last) return;
    if (last == &g_sent_goal && last->num && !last->replied && !last->overdue)
        printf("[REPLY] WP %d goal: NO REPLY before the next goal was sent\n", last->num);
    *last = Sent{num, id, std::chrono::steady_clock::now(), false, false};
}

// num > 0 tracks the message (see Sent) so the robot's reply is printed against waypoint num.
static int sendUDP(const char* json, int num = 0) {
    udpMessage msg;
    memset(&msg, 0, sizeof(msg));
    msg.header[0] = 0xeb; msg.header[1] = 0x91;
    msg.header[2] = 0xeb; msg.header[3] = 0x90;
    unsigned short len = strlen(json);
    msg.header[4] = len & 0xFF;
    msg.header[5] = (len >> 8) & 0xFF;
    msg.header[6] = g_msg_id & 0xFF;
    msg.header[7] = (g_msg_id >> 8) & 0xFF;
    msg.header[8] = 0x01;
    memcpy(msg.data, json, len);
    // before sending, so a fast reply can't arrive ahead of it
    if (num > 0) trackSent(std::atoi(jsonField(json, "Type").c_str()), num, g_msg_id);
    g_msg_id++;
    return sendto(g_fd, &msg, len + 16, 0, (struct sockaddr*)&g_addr, sizeof(g_addr));
}

static void processResponse(const std::string& payload) {
    auto get = [&](const std::string& key) { return jsonField(payload, key); };
    std::string typeStr = get("Type");
    if (typeStr.empty()) return;
    int type = std::atoi(typeStr.c_str());
    int cmd  = std::atoi(get("Command").c_str());

    if (type == 1003 && cmd == 1) {
        int err = std::atoi(get("ErrorCode").c_str());
        printf("[NAV] ErrorCode=%d = %s\n", err, navErrorStr(err));
    } else if (type == 1007 && cmd == 1) {
        int val    = std::atoi(get("Value").c_str());
        int status = std::atoi(get("Status").c_str());
        int err    = std::atoi(get("ErrorCode").c_str());
        printf("[STATUS] Point=%d | %s | Error=%s\n", val, navStatusStr(status), navErrorStr(err));
    }
}

static void listenResponses(int seconds) {
    struct timeval tv = {seconds, 0};
    setsockopt(g_fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    unsigned char buf[8192];
    struct sockaddr_in from;
    socklen_t fromLen = sizeof(from);
    while (true) {
        ssize_t n = recvfrom(g_fd, buf, sizeof(buf), 0, (struct sockaddr*)&from, &fromLen);
        if (n < 0) break;
        if (n > 16)
            processResponse(std::string((char*)buf + 16, n - 16));
    }
}

// One line per message from the robot, against the waypoint it answers. The first message of
// each Type/Command is also printed raw, to show what the robot actually sends.
static void printReply(const std::string& payload, unsigned short reply_id,
                       std::set<std::pair<int, int>>& seen, std::string& last_status) {
    const int type = std::atoi(jsonField(payload, "Type").c_str());
    const int cmd  = std::atoi(jsonField(payload, "Command").c_str());
    std::lock_guard<std::mutex> lk(g_sent_mutex);
    Sent* s = sentFor(type);
    if (seen.insert({type, cmd}).second) {
        char ours[32] = "";
        if (s && s->num) snprintf(ours, sizeof(ours), ", ours was %u", s->id);
        printf("[REPLY] First %d/%d message from the robot (msg id %u%s): %.300s\n",
               type, cmd, reply_id, ours, payload.c_str());
    }
    const std::string code = jsonField(payload, "ErrorCode");
    char err[80] = "no ErrorCode";
    if (!code.empty()) {
        const int e = std::atoi(code.c_str());
        snprintf(err, sizeof(err), "ErrorCode=0x%X (%s)", e, navErrorStr(e));
    }

    if (type == 1007 && cmd == 1) {  // navigation status, printed when it changes
        char status[160];
        snprintf(status, sizeof(status), "point %s | %s | %s", jsonField(payload, "Value").c_str(),
                 navStatusStr(std::atoi(jsonField(payload, "Status").c_str())), err);
        if (last_status != status) printf("[REPLY] Status: %s\n", status);
        last_status = status;
        return;
    }
    if (!s || s->num == 0) return;  // e.g. heartbeat replies
    const char* what = type == 1003 ? "goal" : "mode switch";
    const std::string value = jsonField(payload, "Value");
    if (!value.empty() && std::atoi(value.c_str()) != s->num) {
        printf("[REPLY] WP %s %s (not the latest): %s\n", value.c_str(), what, err);
        return;
    }
    if (s->replied)
        printf("[REPLY] WP %d %s: another message %.1fs after sending, %s\n", s->num, what, secondsSince(s->at), err);
    else
        printf("[REPLY] WP %d %s: answered after %.2fs%s, %s\n", s->num, what, secondsSince(s->at),
               s->overdue ? " (late)" : "", err);
    s->replied = true;
    s->error_code = std::atoi(code.c_str());
}

// Bridge mode only: reads everything the robot sends back. A mode switch the robot hasn't answered
// within REPLY_TIMEOUT_S (lost on the WiFi either way, or ignored) is reported.
static void printReplies() {
    struct timeval tv = {0, 200000};  // wake up to check for unanswered mode switches
    setsockopt(g_fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    std::set<std::pair<int, int>> seen;
    std::string last_status;
    unsigned char buf[8192];
    while (rclcpp::ok()) {
        ssize_t n = recvfrom(g_fd, buf, sizeof(buf), 0, nullptr, nullptr);
        if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) break;
        if (n > 16)
            printReply(std::string((char*)buf + 16, n - 16), static_cast<unsigned short>(buf[6] | (buf[7] << 8)),
                       seen, last_status);
        std::lock_guard<std::mutex> lk(g_sent_mutex);
        Sent& mode = g_sent_mode;
        if (mode.num && !mode.replied && !mode.overdue && secondsSince(mode.at) > REPLY_TIMEOUT_S) {
            printf("[REPLY] WP %d mode switch: NO REPLY within %.0fs (lost on the WiFi, or ignored by the robot)\n",
                   mode.num, REPLY_TIMEOUT_S);
            mode.overdue = true;
        }
    }
}

static const char* waitForArrival(int num, const char* goal, double gx, double gy, int timeout_sec = 120) {
    printf("[NAV] Moving to x=%.4f y=%.4f\n", gx, gy);
    int at_goal_s = 0;
    for (int t = 0; t < timeout_sec; t++) {
        sleep(1);
        sendUDP(R"({"PatrolDevice":{"Type":100,"Command":100,"Time":"2025-01-01 00:00:00","Items":{}}})");
        double cx, cy;
        {
            std::lock_guard<std::mutex> lk(g_pos_mutex);
            if (!g_pos_valid) { printf("[NAV] Waiting for %s... %ds\n", perRobot("/ODOM_relayed").c_str(), t + 1); continue; }
            cx = g_cur_x; cy = g_cur_y;
        }
        double dist = std::sqrt((cx - gx) * (cx - gx) + (cy - gy) * (cy - gy));
        printf("[NAV] x=%.4f y=%.4f dist=%.4fm\n", cx, cy, dist);
        at_goal_s = dist <= 0.1 ? at_goal_s + 1 : 0;
        if (!g_replies_tracked) {
            if (at_goal_s) { printf("[NAV] Arrived (%.4fm)\n", dist); return "ARRIVED"; }
            continue;
        }
        Sent sent;
        {
            std::lock_guard<std::mutex> lk(g_sent_mutex);
            sent = g_sent_goal;
        }
        if (sent.num != num) return "SUPERSEDED";
        if (sent.replied && sent.error_code == NAV_BUSY) {
            printf("[NAV] Robot still busy with its previous task, resending the goal\n");
            sendUDP(goal, num);
        } else if (sent.replied) {
            return at_goal_s ? "ARRIVED" : "STOPPED SHORT";
        } else if (at_goal_s >= 10) {
            printf("[NAV] Within 0.1 m for 10 s but no answer from the robot (lost on the WiFi?)\n");
            return "ARRIVED";
        }
    }
    printf("[NAV] Timeout after %ds\n", timeout_sec);
    return "TIMEOUT";
}

static const char* executeWaypoint(int num, int total, double gx, double gy, double gyaw) {
    printf("\n[WP %d/%d] x=%.4f y=%.4f yaw=%.1fdeg\n", num, total, gx, gy, gyaw * 180.0 / M_PI);

    sendUDP(R"({"PatrolDevice":{"Type":100,"Command":100,"Time":"2025-01-01 00:00:00","Items":{}}})");
    usleep(300000);
    sendUDP(R"({"PatrolDevice":{"Type":1101,"Command":5,"Time":"2025-01-01 00:00:00","Items":{"Mode":1}}})", num);
    usleep(1000000);

    char buf[BUFFER_SIZE];
    snprintf(buf, sizeof(buf),
        R"({"PatrolDevice":{"Type":1003,"Command":1,"Time":"2025-01-01 00:00:00","Items":{"Value":%d,"MapID":0,"PosX":%.6f,"PosY":%.6f,"PosZ":0.0,"AngleYaw":%.6f,"PointInfo":1,"Gait":12290,"Speed":1,"Manner":0,"ObsMode":0,"NavMode":1}}})",
        num, gx, gy, gyaw);
    sendUDP(buf, num);
    const char* outcome = waitForArrival(num, buf, gx, gy);
    double ax, ay;
    {
        std::lock_guard<std::mutex> lk(g_pos_mutex);
        ax = g_cur_x; ay = g_cur_y;
    }
    printf("[WP %d/%d] %s — actual x=%.4f y=%.4f\n", num, total, outcome, ax, ay);
    return outcome;
}

// Immediate: each arrow is driven to at once. Queue: arrows are collected and
// driven once on ENTER. Patrol: arrows are collected and looped on ENTER until Ctrl+C.
enum class Mode { Immediate, Queue, Patrol };

class GoalBridge : public rclcpp::Node {
public:
    GoalBridge(Mode mode) : Node(perRobot("goal_bridge")), mode_(mode) {
        heartbeat_timer_ = create_wall_timer(std::chrono::seconds(1), [this]() {
            sendUDP(R"({"PatrolDevice":{"Type":100,"Command":100,"Time":"2025-01-01 00:00:00","Items":{}}})");
            publishMarkers();  // re-sent so a MarkerArray display added later still shows the route
        });
        goal_sub_ = create_subscription<geometry_msgs::msg::PoseStamped>(
            perRobot("/goal_pose"), 10, std::bind(&GoalBridge::goalCb, this, std::placeholders::_1));
        odom_sub_ = create_subscription<nav_msgs::msg::Odometry>(perRobot("/ODOM_relayed"), 10, storeOdom);
        marker_pub_ = create_publisher<visualization_msgs::msg::MarkerArray>(perRobot("/waypoint_markers"), 10);
        result_pub_ = create_publisher<std_msgs::msg::String>(perRobot("/goal_result"), 10);
        RCLCPP_INFO(get_logger(), "Goals on %s, results on %s, waypoint arrows on %s",
                    goal_sub_->get_topic_name(), result_pub_->get_topic_name(), marker_pub_->get_topic_name());
        if (mode_ == Mode::Queue)
            RCLCPP_INFO(get_logger(), "Queue mode — draw arrows in RViz2, then press ENTER");
        else if (mode_ == Mode::Patrol)
            RCLCPP_INFO(get_logger(), "Patrol mode — draw arrows in RViz2, press ENTER to loop them until Ctrl+C");
        else
            RCLCPP_INFO(get_logger(), "Bridge mode — draw arrow in RViz2 to navigate");
    }

    // Queue/patrol only; blocks on stdin, so run it on its own thread.
    void runRoute() {
        const bool patrol = mode_ == Mode::Patrol;
        const size_t min_wps = patrol ? 2 : 1;
        std::string line;
        while (rclcpp::ok()) {
            printf("\n>>> Draw arrows in RViz2, press ENTER to %s <<<\n\n", patrol ? "start patrol" : "execute");
            if (!std::getline(std::cin, line)) return;
            std::vector<Waypoint> wps;
            {
                std::lock_guard<std::mutex> lk(wps_mutex_);
                if (wps_.size() < min_wps) {
                    printf("[BRIDGE] Need at least %zu waypoint(s), have %zu\n", min_wps, wps_.size());
                    continue;
                }
                wps = wps_;
                running_ = true;
            }
            int total = wps.size();
            printf("\n[BRIDGE] Executing %d waypoints%s\n", total, patrol ? " in a loop — Ctrl+C to stop" : "");
            for (int lap = 1; rclcpp::ok(); lap++) {
                if (patrol) printf("\n[PATROL] Lap %d\n", lap);
                for (int i = 0; i < total && rclcpp::ok(); i++) {
                    setActive(i);
                    executeWaypoint(i + 1, total, wps[i].x, wps[i].y, wps[i].yaw);
                }
                if (!patrol) break;
            }
            printf("[BRIDGE] Done — %d waypoints\n\n", total);
            {
                std::lock_guard<std::mutex> lk(wps_mutex_);
                wps_.clear();
                active_ = -1;
                running_ = false;
            }
            publishMarkers();
        }
    }

private:
    Mode mode_;
    int  wp_count_ = 0;

    std::mutex wps_mutex_;           // guards the four members below
    std::vector<Waypoint> wps_;      // route drawn in RViz2, drawn back as markers
    std::string frame_ = "map";
    int  active_ = -1;               // index in wps_ currently being driven to
    bool running_ = false;

    void goalCb(const geometry_msgs::msg::PoseStamped::SharedPtr msg) {
        double x   = msg->pose.position.x;
        double y   = msg->pose.position.y;
        double yaw = quatToYaw(msg->pose.orientation.x, msg->pose.orientation.y,
                               msg->pose.orientation.z, msg->pose.orientation.w);
        {
            std::lock_guard<std::mutex> lk(wps_mutex_);
            frame_ = msg->header.frame_id;
            if (mode_ == Mode::Immediate) {
                wps_.assign(1, {x, y, yaw});
                active_ = 0;
            } else if (running_) {
                RCLCPP_WARN(get_logger(), "Route already running — goal ignored");
                return;
            } else {
                wps_.push_back({x, y, yaw});
                RCLCPP_INFO(get_logger(), "Queued WP %zu: x=%.3f y=%.3f yaw=%.1fdeg",
                            wps_.size(), x, y, yaw * 180.0 / M_PI);
            }
        }
        publishMarkers();
        if (mode_ == Mode::Immediate) {
            int num = ++wp_count_;
            std::thread([num, x, y, yaw, pub = result_pub_]() {
                std_msgs::msg::String result;
                result.data = executeWaypoint(num, num, x, y, yaw);
                pub->publish(result);
            }).detach();
        }
    }

    void setActive(int i) {
        {
            std::lock_guard<std::mutex> lk(wps_mutex_);
            active_ = i;
        }
        publishMarkers();
    }

    // One arrow + number per waypoint; the current target is green, the rest orange.
    void publishMarkers() {
        visualization_msgs::msg::MarkerArray arr;
        arr.markers.emplace_back();
        arr.markers.back().action = visualization_msgs::msg::Marker::DELETEALL;
        {
            std::lock_guard<std::mutex> lk(wps_mutex_);
            for (size_t i = 0; i < wps_.size(); i++) {
                visualization_msgs::msg::Marker arrow;
                arrow.header.frame_id = frame_;
                arrow.ns = "arrows";
                arrow.id = i;
                arrow.type = visualization_msgs::msg::Marker::ARROW;
                arrow.pose.position.x = wps_[i].x;
                arrow.pose.position.y = wps_[i].y;
                arrow.pose.orientation.z = std::sin(wps_[i].yaw / 2.0);
                arrow.pose.orientation.w = std::cos(wps_[i].yaw / 2.0);
                arrow.scale.x = 0.6; arrow.scale.y = 0.1; arrow.scale.z = 0.1;
                bool active = static_cast<int>(i) == active_;
                arrow.color.r = active ? 0.1 : 1.0;
                arrow.color.g = active ? 0.9 : 0.5;
                arrow.color.b = 0.1;
                arrow.color.a = 1.0;
                arr.markers.push_back(arrow);

                visualization_msgs::msg::Marker label = arrow;
                label.ns = "labels";
                label.type = visualization_msgs::msg::Marker::TEXT_VIEW_FACING;
                label.text = std::to_string(i + 1);
                label.pose.position.z = 0.4;
                label.scale.z = 0.3;
                label.color.r = label.color.g = label.color.b = 1.0;
                arr.markers.push_back(label);
            }
        }
        marker_pub_->publish(arr);
    }

    rclcpp::Subscription<geometry_msgs::msg::PoseStamped>::SharedPtr goal_sub_;
    rclcpp::Subscription<nav_msgs::msg::Odometry>::SharedPtr odom_sub_;
    rclcpp::Publisher<visualization_msgs::msg::MarkerArray>::SharedPtr marker_pub_;
    rclcpp::Publisher<std_msgs::msg::String>::SharedPtr result_pub_;
    rclcpp::TimerBase::SharedPtr heartbeat_timer_;
};

struct Config {
    std::string robot_ip = "192.168.8.101";
    bool wait = false;
    std::vector<std::string> args;
};

static Config parseArgs(int argc, char* argv[]) {
    Config cfg;
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        if (a == "--ros-args") break;
        if (a == "--ip" && i + 1 < argc) cfg.robot_ip = argv[++i];
        else if (a == "--wait") cfg.wait = true;
        else cfg.args.push_back(a);
    }
    return cfg;
}

static void initSocket(const std::string& ip) {
    g_fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (g_fd < 0) { perror("socket"); exit(1); }
    memset(&g_addr, 0, sizeof(g_addr));
    g_addr.sin_family      = AF_INET;
    g_addr.sin_port        = htons(PORT);
    inet_pton(AF_INET, ip.c_str(), &g_addr.sin_addr);
}

int main(int argc, char* argv[]) {
    Config cfg = parseArgs(argc, argv);
    initSocket(cfg.robot_ip);
    const auto& args = cfg.args;

    if (args.empty() || args[0] == "bridge") {
        const std::string sub = args.size() >= 2 ? args[1] : "";
        Mode mode = sub == "queue" ? Mode::Queue : sub == "patrol" ? Mode::Patrol : Mode::Immediate;
        rclcpp::init(argc, argv);
        auto node = std::make_shared<GoalBridge>(mode);
        g_replies_tracked = true;
        std::thread(printReplies).detach();
        // The thread holds its own reference: at Ctrl+C it can still be mid-waypoint.
        if (mode != Mode::Immediate)
            std::thread([node]() { node->runRoute(); }).detach();
        rclcpp::spin(node);
        rclcpp::shutdown();
        close(g_fd);
        return 0;
    }

    const std::string cmd = args[0];

    if (cmd == "nav") {
        if (args.size() < 3) { printf("Usage: nav <x> <y> [yaw] [--wait]\n"); close(g_fd); return 1; }
        double x   = std::atof(args[1].c_str());
        double y   = std::atof(args[2].c_str());
        double yaw = args.size() > 3 ? std::atof(args[3].c_str()) : 0.0;
        if (cfg.wait) {
            // Blocks until arrival or timeout, tracked on /ODOM_relayed (used by benchmark.py)
            rclcpp::init(argc, argv);
            auto node = std::make_shared<rclcpp::Node>(perRobot("nav_node"));
            auto odom_sub = node->create_subscription<nav_msgs::msg::Odometry>(
                perRobot("/ODOM_relayed"), 10, storeOdom);
            std::thread ros_thread([&node]() { rclcpp::spin(node); });
            executeWaypoint(1, 1, x, y, yaw);
            rclcpp::shutdown();
            ros_thread.join();
        } else {
            printf("Target: x=%.4f y=%.4f yaw=%.4f\n", x, y, yaw);
            sendUDP(R"({"PatrolDevice":{"Type":100,"Command":100,"Time":"2025-01-01 00:00:00","Items":{}}})");
            usleep(300000);
            sendUDP(R"({"PatrolDevice":{"Type":1101,"Command":5,"Time":"2025-01-01 00:00:00","Items":{"Mode":1}}})");
            usleep(1000000);
            char buf[BUFFER_SIZE];
            snprintf(buf, sizeof(buf),
                R"({"PatrolDevice":{"Type":1003,"Command":1,"Time":"2025-01-01 00:00:00","Items":{"Value":1,"MapID":0,"PosX":%.6f,"PosY":%.6f,"PosZ":0.0,"AngleYaw":%.6f,"PointInfo":1,"Gait":12290,"Speed":1,"Manner":0,"ObsMode":0,"NavMode":1}}})",
                x, y, yaw);
            sendUDP(buf);
            listenResponses(5);
        }
    }

    else if (cmd == "estop") {
        sendUDP(R"({"PatrolDevice":{"Type":2,"Command":22,"Time":"2025-01-01 00:00:00","Items":{"MotionParam":2}}})");
        printf("estop sent\n");
        listenResponses(3);
    }

    else if (cmd == "standup") {
        sendUDP(R"({"PatrolDevice":{"Type":2,"Command":2,"Time":"2025-01-01 00:00:00","Items":{"MotionParam":1}}})");
        printf("standup sent\n");
        listenResponses(3);
    }

    else if (cmd == "cancel") {
        sendUDP(R"({"PatrolDevice":{"Type":1004,"Command":1,"Time":"2025-01-01 00:00:00","Items":{}}})");
        printf("cancel sent\n");
        listenResponses(3);
    }

    else {
        printf("Unknown command: %s\n", cmd.c_str());
        printf("Commands: nav, bridge, bridge queue, bridge patrol, estop, cancel, standup\n");
        printf("Flags:    --ip <addr>  (default 192.168.8.101)\n");
        printf("          --wait       (nav only: block until arrival)\n");
        close(g_fd); return 1;
    }

    close(g_fd);
    return 0;
}
