#include <arpa/inet.h>
#include <sys/socket.h>
#include <unistd.h>
#include <cmath>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <sstream>
#include <vector>
#include <queue>
#include <mutex>
#include <thread>

#include "rclcpp/rclcpp.hpp"
#include "geometry_msgs/msg/pose_stamped.hpp"
#include "nav_msgs/msg/odometry.hpp"

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
static std::queue<Waypoint> g_wp_queue;
static std::mutex g_queue_mutex;

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

static bool parseWaypoint(const std::string& s, Waypoint& wp) {
    std::stringstream ss(s);
    std::string tok;
    std::vector<double> v;
    while (std::getline(ss, tok, ','))
        v.push_back(std::atof(tok.c_str()));
    if (v.size() < 2) return false;
    wp.x = v[0]; wp.y = v[1]; wp.yaw = v.size() >= 3 ? v[2] : 0.0;
    return true;
}

static int sendUDP(const char* json) {
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
    g_msg_id++;
    return sendto(g_fd, &msg, len + 16, 0, (struct sockaddr*)&g_addr, sizeof(g_addr));
}

static void processResponse(const std::string& payload) {
    auto get = [&](const std::string& key) -> std::string {
        std::string search = "\"" + key + "\":";
        size_t pos = payload.find(search);
        if (pos == std::string::npos) return "";
        pos += search.length();
        while (pos < payload.size() && (payload[pos] == ' ' || payload[pos] == '"')) pos++;
        size_t end = pos;
        while (end < payload.size() && payload[end] != ',' && payload[end] != '}' && payload[end] != '"') end++;
        return payload.substr(pos, end - pos);
    };
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

static bool waitForArrival(double gx, double gy, int timeout_sec = 120) {
    printf("[NAV] Moving to x=%.4f y=%.4f\n", gx, gy);
    for (int t = 0; t < timeout_sec; t++) {
        sleep(1);
        sendUDP(R"({"PatrolDevice":{"Type":100,"Command":100,"Time":"2025-01-01 00:00:00","Items":{}}})");
        double cx, cy;
        {
            std::lock_guard<std::mutex> lk(g_pos_mutex);
            if (!g_pos_valid) { printf("[NAV] Waiting for ODOM... %ds\n", t + 1); continue; }
            cx = g_cur_x; cy = g_cur_y;
        }
        double dist = std::sqrt((cx - gx) * (cx - gx) + (cy - gy) * (cy - gy));
        printf("[NAV] x=%.4f y=%.4f dist=%.4fm\n", cx, cy, dist);
        if (dist <= 0.1) { printf("[NAV] Arrived (%.4fm)\n", dist); return true; }
    }
    printf("[NAV] Timeout after %ds\n", timeout_sec);
    return false;
}

static void executeWaypoint(int num, int total, double gx, double gy, double gyaw) {
    printf("\n[WP %d/%d] x=%.4f y=%.4f yaw=%.1fdeg\n", num, total, gx, gy, gyaw * 180.0 / M_PI);
    char buf[BUFFER_SIZE];
    snprintf(buf, sizeof(buf),
        R"({"PatrolDevice":{"Type":1003,"Command":1,"Time":"2025-01-01 00:00:00","Items":{"Value":%d,"MapID":0,"PosX":%.6f,"PosY":%.6f,"PosZ":0.0,"AngleYaw":%.6f,"PointInfo":1,"Gait":12290,"Speed":1,"Manner":0,"ObsMode":0,"NavMode":1}}})",
        num, gx, gy, gyaw);
    sendUDP(buf);
    bool arrived = waitForArrival(gx, gy);
    double ax, ay;
    {
        std::lock_guard<std::mutex> lk(g_pos_mutex);
        ax = g_cur_x; ay = g_cur_y;
    }
    printf("[WP %d/%d] %s — actual x=%.4f y=%.4f\n", num, total, arrived ? "ARRIVED" : "TIMEOUT", ax, ay);
}

class GoalBridge : public rclcpp::Node {
public:
    GoalBridge(bool queue_mode) : Node("goal_bridge"), wp_count_(0), queue_mode_(queue_mode) {
        heartbeat_timer_ = create_wall_timer(std::chrono::seconds(1), [this]() {
            sendUDP(R"({"PatrolDevice":{"Type":100,"Command":100,"Time":"2025-01-01 00:00:00","Items":{}}})");
        });
        goal_sub_ = create_subscription<geometry_msgs::msg::PoseStamped>(
            "/goal_pose", 10, std::bind(&GoalBridge::goalCb, this, std::placeholders::_1));
        odom_sub_ = create_subscription<nav_msgs::msg::Odometry>(
            "/ODOM", 10, std::bind(&GoalBridge::odomCb, this, std::placeholders::_1));
        if (queue_mode_) {
            RCLCPP_INFO(get_logger(), "Queue mode — draw arrows in RViz2, then press ENTER");
            std::thread([this]() {
                printf("\n>>> Draw arrows in RViz2, press ENTER to execute <<<\n\n");
                std::cin.get();
                executeQueue();
            }).detach();
        } else {
            RCLCPP_INFO(get_logger(), "Bridge mode — draw arrow in RViz2 to navigate");
        }
    }

private:
    int  wp_count_;
    bool queue_mode_;

    void odomCb(const nav_msgs::msg::Odometry::SharedPtr msg) {
        std::lock_guard<std::mutex> lk(g_pos_mutex);
        g_cur_x   = msg->pose.pose.position.x;
        g_cur_y   = msg->pose.pose.position.y;
        g_cur_yaw = quatToYaw(msg->pose.pose.orientation.x, msg->pose.pose.orientation.y,
                              msg->pose.pose.orientation.z, msg->pose.pose.orientation.w);
        g_pos_valid = true;
    }

    void goalCb(const geometry_msgs::msg::PoseStamped::SharedPtr msg) {
        double x   = msg->pose.position.x;
        double y   = msg->pose.position.y;
        double yaw = quatToYaw(msg->pose.orientation.x, msg->pose.orientation.y,
                               msg->pose.orientation.z, msg->pose.orientation.w);
        if (queue_mode_) {
            std::lock_guard<std::mutex> lk(g_queue_mutex);
            g_wp_queue.push({x, y, yaw});
            RCLCPP_INFO(get_logger(), "Queued WP %zu: x=%.3f y=%.3f yaw=%.1fdeg",
                        g_wp_queue.size(), x, y, yaw * 180.0 / M_PI);
        } else {
            int num = ++wp_count_;
            std::thread([num, x, y, yaw]() {
                executeWaypoint(num, num, x, y, yaw);
            }).detach();
        }
    }

    void executeQueue() {
        std::vector<Waypoint> wps;
        {
            std::lock_guard<std::mutex> lk(g_queue_mutex);
            if (g_wp_queue.empty()) { printf("[BRIDGE] Queue is empty\n"); return; }
            while (!g_wp_queue.empty()) { wps.push_back(g_wp_queue.front()); g_wp_queue.pop(); }
        }
        int total = wps.size();
        printf("\n[BRIDGE] Executing %d waypoints\n", total);
        for (int i = 0; i < total; i++)
            executeWaypoint(i + 1, total, wps[i].x, wps[i].y, wps[i].yaw);
        printf("[BRIDGE] Done — %d waypoints\n\n", total);
    }

    rclcpp::Subscription<geometry_msgs::msg::PoseStamped>::SharedPtr goal_sub_;
    rclcpp::Subscription<nav_msgs::msg::Odometry>::SharedPtr odom_sub_;
    rclcpp::TimerBase::SharedPtr heartbeat_timer_;
};

struct Config {
    std::string robot_ip = "192.168.8.101";
    std::vector<std::string> args;
};

static Config parseArgs(int argc, char* argv[]) {
    Config cfg;
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        if (a == "--ros-args") break;
        if (a == "--ip" && i + 1 < argc) cfg.robot_ip = argv[++i];
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
        bool queue = args.size() >= 2 && args[1] == "queue";
        rclcpp::init(argc, argv);
        rclcpp::spin(std::make_shared<GoalBridge>(queue));
        rclcpp::shutdown();
        close(g_fd);
        return 0;
    }

    const std::string cmd = args[0];

    if (cmd == "nav") {
        if (args.size() < 3) { printf("Usage: nav <x> <y> [yaw]\n"); close(g_fd); return 1; }
        double x   = std::atof(args[1].c_str());
        double y   = std::atof(args[2].c_str());
        double yaw = args.size() > 3 ? std::atof(args[3].c_str()) : 0.0;
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

    else if (cmd == "patrol") {
        if (args.size() < 2) { printf("Usage: patrol <x,y,yaw> ...\n"); close(g_fd); return 1; }
        std::vector<Waypoint> wps;
        for (size_t i = 1; i < args.size(); i++) {
            Waypoint wp;
            if (!parseWaypoint(args[i], wp)) {
                printf("[ERROR] Bad waypoint: %s\n", args[i].c_str());
                close(g_fd); return 1;
            }
            wps.push_back(wp);
        }

        rclcpp::init(argc, argv);
        auto node = std::make_shared<rclcpp::Node>("patrol_node");
        auto odom_sub = node->create_subscription<nav_msgs::msg::Odometry>(
            "/ODOM", 10,
            [](const nav_msgs::msg::Odometry::SharedPtr msg) {
                std::lock_guard<std::mutex> lk(g_pos_mutex);
                g_cur_x   = msg->pose.pose.position.x;
                g_cur_y   = msg->pose.pose.position.y;
                g_cur_yaw = quatToYaw(msg->pose.pose.orientation.x,
                                      msg->pose.pose.orientation.y,
                                      msg->pose.pose.orientation.z,
                                      msg->pose.pose.orientation.w);
                g_pos_valid = true;
            });
        std::thread ros_thread([&node]() { rclcpp::spin(node); });

        sendUDP(R"({"PatrolDevice":{"Type":100,"Command":100,"Time":"2025-01-01 00:00:00","Items":{}}})");
        usleep(300000);
        sendUDP(R"({"PatrolDevice":{"Type":1101,"Command":5,"Time":"2025-01-01 00:00:00","Items":{"Mode":1}}})");
        usleep(1000000);

        int total = wps.size();
        for (int i = 0; i < total; i++)
            executeWaypoint(i + 1, total, wps[i].x, wps[i].y, wps[i].yaw);

        printf("\n[PATROL] Done — %d waypoints\n", total);

        rclcpp::shutdown();
        ros_thread.join();
    }

    else if (cmd == "estop") {
        sendUDP(R"({"PatrolDevice":{"Type":2,"Command":22,"Time":"2025-01-01 00:00:00","Items":{"MotionParam":2}}})");
        printf("estop sent\n");
        listenResponses(3);
    }

    else if (cmd == "cancel") {
        sendUDP(R"({"PatrolDevice":{"Type":1004,"Command":1,"Time":"2025-01-01 00:00:00","Items":{}}})");
        printf("cancel sent\n");
        listenResponses(3);
    }

    else {
        printf("Unknown command: %s\n", cmd.c_str());
        printf("Commands: nav, patrol, bridge, bridge queue, estop, cancel\n");
        printf("Flags:    --ip <addr>  (default 10.21.31.103)\n");
        close(g_fd); return 1;
    }

    close(g_fd);
    return 0;
}
