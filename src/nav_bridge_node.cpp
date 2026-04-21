// ============================================================
//  nav_bridge_node.cpp
//  ROS 2 Foxy  –  Navigation Command Bridge for DeepRobotics M20
//
//  Core functionality:
//    1. UDP command transport to robot (binary header + JSON)
//    2. /ODOM subscription for live position tracking
//    3. /goal_pose subscription (RViz2 bridge) – immediate & queue
//    4. CLI commands: nav, patrol, bridge, status, loc, etc.
//    5. CSV data logging (path configurable via --csv flag)
// ============================================================

#include <iostream>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <cmath>
#include <fstream>
#include <vector>
#include <sstream>
#include <queue>
#include <mutex>
#include <condition_variable>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <thread>
#include <atomic>
#include <sys/stat.h>

#include "rclcpp/rclcpp.hpp"
#include "geometry_msgs/msg/pose_stamped.hpp"
#include "nav_msgs/msg/odometry.hpp"

#include "nav_cmd_bridge/nav_bridge.hpp"

// ============================================================
//  Global State Definitions
// ============================================================
unsigned short g_msgId = 0;
int            g_fd;
struct sockaddr_in g_addr;

std::queue<Waypoint> g_waypoint_queue;
std::mutex           g_queue_mutex;

std::mutex g_pos_mutex;
double     g_cur_x     = 0.0;
double     g_cur_y     = 0.0;
double     g_cur_yaw   = 0.0;
bool       g_pos_valid = false;

std::string g_csv_file = DEFAULT_CSV_FILE;

// ============================================================
//  Utility Functions
// ============================================================
std::string jsonGet(const std::string &json, const std::string &key) {
    std::string search = "\"" + key + "\":";
    size_t pos = json.find(search);
    if (pos == std::string::npos) return "";
    pos += search.length();
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '"')) pos++;
    size_t end = pos;
    while (end < json.size() && json[end] != ',' && json[end] != '}' && json[end] != '"') end++;
    return json.substr(pos, end - pos);
}

std::string getTimestamp() {
    time_t now = time(nullptr);
    char buf[32];
    strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", localtime(&now));
    return std::string(buf);
}

double quatToYaw(double x, double y, double z, double w) {
    return std::atan2(2.0 * (w * z + x * y),
                      1.0 - 2.0 * (y * y + z * z));
}

bool parseWaypoint(const std::string &s, Waypoint &wp) {
    std::stringstream ss(s);
    std::string token;
    std::vector<double> vals;
    while (std::getline(ss, token, ',')) {
        vals.push_back(atof(token.c_str()));
    }
    if (vals.size() < 2) return false;
    wp.x   = vals[0];
    wp.y   = vals[1];
    wp.yaw = (vals.size() >= 3) ? vals[2] : 0.0;
    return true;
}

// ============================================================
//  UDP Communication
// ============================================================
int sendUDP(int fd, struct sockaddr_in &addr, const char *json) {
    udpMessage msg;
    memset(&msg, 0, sizeof(msg));
    msg.header[0] = 0xeb;
    msg.header[1] = 0x91;
    msg.header[2] = 0xeb;
    msg.header[3] = 0x90;
    unsigned short len = strlen(json);
    msg.header[4] = len & 0xFF;
    msg.header[5] = (len >> 8) & 0xFF;
    msg.header[6] = g_msgId & 0xFF;
    msg.header[7] = (g_msgId >> 8) & 0xFF;
    msg.header[8] = 0x01;
    memcpy(msg.data, json, len);
    g_msgId++;
    return sendto(fd, &msg, len + 16, 0, (struct sockaddr *)&addr, sizeof(addr));
}

void processResponse(const std::string &payload) {
    std::string typeStr = jsonGet(payload, "Type");
    std::string cmdStr  = jsonGet(payload, "Command");
    if (typeStr.empty()) return;
    int type = atoi(typeStr.c_str());
    int cmd  = atoi(cmdStr.c_str());

    if (type == 1002 && cmd == 6) {
        int ms   = atoi(jsonGet(payload, "MotionState").c_str());
        int gait = atoi(jsonGet(payload, "Gait").c_str());
        int mode = atoi(jsonGet(payload, "ControlUsageMode").c_str());
        int hes  = atoi(jsonGet(payload, "HES").c_str());
        printf("[BASIC STATUS] MotionState=%d (%s) | Gait=%d (0x%X) | Mode=%d | HES=%d\n",
               ms, motionStateStr(ms), gait, gait, mode, hes);
    }
    else if (type == 1003 && cmd == 1) {
        int errCode = atoi(jsonGet(payload, "ErrorCode").c_str());
        std::string errMsg = jsonGet(payload, "ErrorMessage");
        printf("\n*** [NAV RESPONSE] ErrorCode=%d (0x%X) = %s",
               errCode, errCode, navErrorStr(errCode));
        if (!errMsg.empty()) printf(" | Message: %s", errMsg.c_str());
        printf(" ***\n\n");
    }
    else if (type == 1007 && cmd == 1) {
        int value   = atoi(jsonGet(payload, "Value").c_str());
        int status  = atoi(jsonGet(payload, "Status").c_str());
        int errCode = atoi(jsonGet(payload, "ErrorCode").c_str());
        printf("\n>>> [NAV STATUS] Point=%d | Status=%d (%s) | ErrorCode=%d (0x%X) = %s <<<\n\n",
               value, status, navStatusStr(status), errCode, errCode, navErrorStr(errCode));
    }
    else if (type == 1007 && cmd == 2) {
        std::string loc = jsonGet(payload, "Location");
        std::string px  = jsonGet(payload, "PosX");
        std::string py  = jsonGet(payload, "PosY");
        std::string yaw = jsonGet(payload, "Yaw");
        printf("[LOCATION] Status=%s | x=%s y=%s yaw=%s\n",
               loc == "0" ? "OK" : "LOST", px.c_str(), py.c_str(), yaw.c_str());
    }
    else if (type == 100 && cmd == 100) {
        // Suppress heartbeat ack spam
    }
    else if (type == 1101 && cmd == 5) {
        int errCode = atoi(jsonGet(payload, "ErrorCode").c_str());
        printf("[MODE SWITCH] ErrorCode=%d (%s)\n",
               errCode, errCode == 0 ? "Success" : "Failed");
    }
    else if (type == 1002 && cmd == 3) {
        std::string errs = jsonGet(payload, "ErrorList");
        if (!errs.empty() && errs != "[]") {
            printf("[ROBOT ERRORS] %s\n", errs.c_str());
        }
    }
}

void listenResponses(int fd, int seconds) {
    struct timeval tv;
    tv.tv_sec = seconds;
    tv.tv_usec = 0;
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    unsigned char buf[8192];
    struct sockaddr_in from;
    socklen_t fromLen = sizeof(from);
    while (true) {
        ssize_t n = recvfrom(fd, buf, sizeof(buf), 0,
                             (struct sockaddr *)&from, &fromLen);
        if (n < 0) break;
        if (n > 16) {
            std::string payload((char *)buf + 16, n - 16);
            processResponse(payload);
        }
    }
}

// JSON-only location response handler (for --json flag)
static void processLocationJSON(const std::string &payload) {
    std::string typeStr = jsonGet(payload, "Type");
    std::string cmdStr  = jsonGet(payload, "Command");
    if (typeStr.empty()) return;
    int type = atoi(typeStr.c_str());
    int cmd  = atoi(cmdStr.c_str());

    if (type == 1007 && cmd == 2) {
        std::string loc = jsonGet(payload, "Location");
        std::string px  = jsonGet(payload, "PosX");
        std::string py  = jsonGet(payload, "PosY");
        std::string yaw = jsonGet(payload, "Yaw");
        printf("{\"x\":%s,\"y\":%s,\"yaw\":%s,\"status\":\"%s\"}\n",
               px.c_str(), py.c_str(), yaw.c_str(),
               loc == "0" ? "OK" : "LOST");
    }
}

static void listenResponsesJSON(int fd, int seconds) {
    struct timeval tv;
    tv.tv_sec = seconds;
    tv.tv_usec = 0;
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    unsigned char buf[8192];
    struct sockaddr_in from;
    socklen_t fromLen = sizeof(from);
    while (true) {
        ssize_t n = recvfrom(fd, buf, sizeof(buf), 0,
                             (struct sockaddr *)&from, &fromLen);
        if (n < 0) break;
        if (n > 16) {
            std::string payload((char *)buf + 16, n - 16);
            processLocationJSON(payload);
        }
    }
}

// ============================================================
//  CSV Logging
// ============================================================
// Create parent directories for the given file path (mkdir -p equivalent).
static void ensureParentDir(const std::string &path) {
    size_t slash = path.find_last_of('/');
    if (slash == std::string::npos) return;
    std::string dir = path.substr(0, slash);
    if (dir.empty()) return;

    // Create each directory component in the path
    size_t pos = 0;
    while ((pos = dir.find('/', pos + 1)) != std::string::npos) {
        std::string sub = dir.substr(0, pos);
        if (!sub.empty()) mkdir(sub.c_str(), 0755);
    }
    mkdir(dir.c_str(), 0755);
}

void initCSV() {
    ensureParentDir(g_csv_file);
    struct stat st;
    if (stat(g_csv_file.c_str(), &st) != 0) {
        std::ofstream f(g_csv_file);
        if (f.is_open()) {
            f << "timestamp,"
              << "waypoint_num,"
              << "target_x,"
              << "target_y,"
              << "target_yaw_deg,"
              << "actual_x,"
              << "actual_y,"
              << "actual_yaw_deg,"
              << "distance_error_m,"
              << "heading_error_deg,"
              << "nav_completed,"
              << "result\n";
            f.close();
            printf("[CSV] Created new log file: %s\n", g_csv_file.c_str());
        } else {
            printf("[CSV] ERROR: Could not create log file: %s\n", g_csv_file.c_str());
        }
    } else {
        printf("[CSV] Appending to existing log file: %s\n", g_csv_file.c_str());
    }
}

void logToCSV(int wp_num,
              double goal_x,  double goal_y,  double goal_yaw,
              double actual_x, double actual_y, double actual_yaw,
              double distance, double heading_err_deg,
              bool nav_completed, bool pass)
{
    std::ofstream f(g_csv_file, std::ios::app);
    if (!f.is_open()) {
        printf("[CSV] ERROR: Could not open log file for writing\n");
        return;
    }
    f << getTimestamp()             << ","
      << wp_num                     << ","
      << goal_x                     << ","
      << goal_y                     << ","
      << (goal_yaw * 180.0/M_PI)   << ","
      << actual_x                   << ","
      << actual_y                   << ","
      << (actual_yaw * 180.0/M_PI) << ","
      << distance                   << ","
      << heading_err_deg            << ","
      << (nav_completed ? "YES" : "NO") << ","
      << (pass ? "PASS" : "FAIL")  << "\n";
    f.close();
    printf("[CSV] Result logged to %s\n", g_csv_file.c_str());
}

// ============================================================
//  Navigation Execution
// ============================================================
bool waitForArrival(int timeoutSeconds, double goal_x, double goal_y) {
    printf("[WAITING] Moving to goal x=%.4f y=%.4f ...\n", goal_x, goal_y);
    int elapsed = 0;
    while (elapsed < timeoutSeconds) {
        sleep(1);
        elapsed += 1;

        sendUDP(g_fd, g_addr,
            R"({"PatrolDevice":{"Type":100,"Command":100,"Time":"2025-01-01 00:00:00","Items":{}}})");

        double cur_x, cur_y, cur_yaw;
        {
            std::lock_guard<std::mutex> lock(g_pos_mutex);
            if (!g_pos_valid) {
                printf("[WAITING] No ODOM data yet... %ds\n", elapsed);
                continue;
            }
            cur_x   = g_cur_x;
            cur_y   = g_cur_y;
            cur_yaw = g_cur_yaw;
        }

        double dx   = cur_x - goal_x;
        double dy   = cur_y - goal_y;
        double dist = std::sqrt(dx*dx + dy*dy);

        printf("[POSITION] x=%.4f y=%.4f | dist_to_goal=%.4fm\n",
               cur_x, cur_y, dist);

        if (dist <= SETTLE_THRESHOLD) {
            printf("[ARRIVED] Within %.4fm of target\n", dist);
            return true;
        }
    }
    printf("[TIMEOUT] Did not reach goal within %ds\n", timeoutSeconds);
    return false;
}

bool executeAndLog(int wp_num, int total,
                   double goal_x, double goal_y, double goal_yaw,
                   int &pass_count)
{
    printf("\n========================================\n");
    printf("[WAYPOINT %d/%d] COMMANDED\n", wp_num, total);
    printf("  Target : x=%.4f  y=%.4f  yaw=%.4f (%.1f deg)\n",
           goal_x, goal_y, goal_yaw, goal_yaw * 180.0 / M_PI);
    printf("========================================\n");

    sendUDP(g_fd, g_addr,
        R"({"PatrolDevice":{"Type":100,"Command":100,"Time":"2025-01-01 00:00:00","Items":{}}})");
    usleep(300000);

    sendUDP(g_fd, g_addr,
        R"({"PatrolDevice":{"Type":1101,"Command":5,"Time":"2025-01-01 00:00:00","Items":{"Mode":1}}})");
    usleep(1000000);

    char buf[BUFFER_SIZE];
    snprintf(buf, sizeof(buf),
        R"({"PatrolDevice":{"Type":1003,"Command":1,"Time":"2025-01-01 00:00:00","Items":{"Value":%d,"MapID":0,"PosX":%.6f,"PosY":%.6f,"PosZ":0.0,"AngleYaw":%.6f,"PointInfo":1,"Gait":12290,"Speed":1,"Manner":0,"ObsMode":0,"NavMode":1}}})",
        wp_num, goal_x, goal_y, goal_yaw);
    sendUDP(g_fd, g_addr, buf);
    printf("[SENT] Navigation task dispatched\n");

    bool completed = waitForArrival(120, goal_x, goal_y);

    printf("\n----------------------------------------\n");
    if (completed)
        printf("[WAYPOINT %d/%d] ARRIVED\n", wp_num, total);
    else
        printf("[WAYPOINT %d/%d] TIMEOUT/FAILED\n", wp_num, total);

    double actual_x, actual_y, actual_yaw;
    {
        std::lock_guard<std::mutex> lock(g_pos_mutex);
        actual_x   = g_cur_x;
        actual_y   = g_cur_y;
        actual_yaw = g_cur_yaw;
    }

    double dx       = actual_x - goal_x;
    double dy       = actual_y - goal_y;
    double distance = std::sqrt(dx*dx + dy*dy);
    double dyaw     = actual_yaw - goal_yaw;
    while (dyaw >  M_PI) dyaw -= 2*M_PI;
    while (dyaw < -M_PI) dyaw += 2*M_PI;
    double dyaw_deg = std::fabs(dyaw * 180.0 / M_PI);

    bool pass = completed && (distance <= SETTLE_THRESHOLD);
    if (pass) pass_count++;

    printf("[WAYPOINT %d/%d] RESULTS\n", wp_num, total);
    printf("  Target  : x=%.4f  y=%.4f  yaw=%.1f deg\n",
           goal_x, goal_y, goal_yaw * 180.0 / M_PI);
    printf("  Actual  : x=%.4f  y=%.4f  yaw=%.1f deg\n",
           actual_x, actual_y, actual_yaw * 180.0 / M_PI);
    printf("  Error   : dist=%.4fm  heading=%.1f deg\n",
           distance, dyaw_deg);

    if (pass)
        printf("  RESULT  : PASS (%.4fm < %.2fm threshold)\n",
               distance, SETTLE_THRESHOLD);
    else if (!completed)
        printf("  RESULT  : FAIL (did not reach goal)\n");
    else
        printf("  RESULT  : FAIL (%.4fm > %.2fm threshold)\n",
               distance, SETTLE_THRESHOLD);

    printf("  SCORE   : %d/%d passed\n", pass_count, wp_num);

    logToCSV(wp_num, goal_x, goal_y, goal_yaw,
             actual_x, actual_y, actual_yaw,
             distance, dyaw_deg, completed, pass);

    printf("----------------------------------------\n\n");
    return pass;
}

// ============================================================
//  Queue Helpers
// ============================================================
void saveQueueToFile() {
    std::ofstream f(QUEUE_FILE);
    if (!f.is_open()) {
        printf("[ERROR] Could not write queue file: %s\n", QUEUE_FILE);
        return;
    }
    std::queue<Waypoint> tmp = g_waypoint_queue;
    while (!tmp.empty()) {
        Waypoint wp = tmp.front(); tmp.pop();
        f << wp.x << "," << wp.y << "," << wp.yaw << "\n";
    }
    f.close();
    printf("[QUEUE] Saved %zu waypoints to file\n", g_waypoint_queue.size());
}

void printUsage(const char *prog) {
    printf("\nUsage: %s <command> [args] [--csv <path>]\n\n", prog);
    printf("Commands:\n");
    printf("  nav <x> <y> [yaw]              Send single navigation goal\n");
    printf("  patrol <x,y,yaw> <x,y,yaw> ... Send multiple waypoints in sequence\n");
    printf("  bridge                         RViz2 bridge - execute goals immediately\n");
    printf("  bridge queue                   RViz2 bridge - queue goals, press ENTER to execute all\n");
    printf("  status                         Query navigation task status\n");
    printf("  loc [--json]                   Query robot location in map\n");
    printf("  cancel                         Cancel current navigation task\n");
    printf("  monitor                        Continuously monitor robot state\n");
    printf("  heartbeat                      Send heartbeat and show basic status\n");
    printf("  stand                          Stand up\n");
    printf("  sit                            Sit down\n");
    printf("  estop                          Soft emergency stop\n");
    printf("  nav_mode                       Switch to navigation mode\n");
    printf("  regular_mode                   Switch to regular mode\n");
    printf("  gait_flat                      Switch to flat agile gait\n");
    printf("  gait_stair                     Switch to stair agile gait\n");
    printf("  clearqueue                     Clear the waypoint queue file\n");
    printf("\nFlags:\n");
    printf("  --csv <path>                   Override CSV output path\n");
    printf("  --json                         Machine-readable JSON output (loc only)\n");
    printf("\nExamples:\n");
    printf("  %s nav 2.15 0.83 1.567\n", prog);
    printf("  %s patrol 2.0,1.0,0.0  4.0,2.0,1.57  0.0,0.0,0.0\n", prog);
    printf("  %s patrol 1.0,2.0 3.0,4.0 --csv /tmp/results.csv\n", prog);
    printf("  %s loc --json\n", prog);
    printf("  %s bridge              (immediate mode)\n", prog);
    printf("  %s bridge queue        (queue mode)\n", prog);
    printf("\n");
}

// ============================================================
//  ROS 2 Node: GoalBridge
// ============================================================
class GoalBridge : public rclcpp::Node
{
public:
    GoalBridge(bool queue_mode)
        : Node("goal_bridge"), waypoint_count_(0), pass_count_(0),
          queue_mode_(queue_mode)
    {
        initCSV();

        heartbeat_timer_ = this->create_wall_timer(
            std::chrono::seconds(1),
            [this]() {
                sendUDP(g_fd, g_addr,
                    R"({"PatrolDevice":{"Type":100,"Command":100,"Time":"2025-01-01 00:00:00","Items":{}}})");
            });

        goal_sub_ = this->create_subscription<geometry_msgs::msg::PoseStamped>(
            "/goal_pose", 10,
            std::bind(&GoalBridge::goalCb, this, std::placeholders::_1));

        odom_sub_ = this->create_subscription<nav_msgs::msg::Odometry>(
            "/ODOM", 10,
            std::bind(&GoalBridge::odomCb, this, std::placeholders::_1));

        if (queue_mode_) {
            RCLCPP_INFO(this->get_logger(),
                "QUEUE MODE - Draw arrows in RViz2 to add to queue.");
            RCLCPP_INFO(this->get_logger(),
                "Press ENTER once when done to execute all waypoints automatically.");

            std::thread([this]() {
                printf("\n>>> Draw your arrows in RViz2, then press ENTER to execute all <<<\n\n");
                std::cin.get();
                executeQueue();
            }).detach();

        } else {
            RCLCPP_INFO(this->get_logger(),
                "IMMEDIATE MODE - Draw arrow in RViz2 to navigate.");
        }
        RCLCPP_INFO(this->get_logger(),
            "Pass threshold: %.2fm | Log: %s",
            SETTLE_THRESHOLD, g_csv_file.c_str());
    }

private:
    int waypoint_count_;
    int pass_count_;
    bool queue_mode_;

    void odomCb(const nav_msgs::msg::Odometry::SharedPtr msg)
    {
        double qx = msg->pose.pose.orientation.x;
        double qy = msg->pose.pose.orientation.y;
        double qz = msg->pose.pose.orientation.z;
        double qw = msg->pose.pose.orientation.w;

        std::lock_guard<std::mutex> lock(g_pos_mutex);
        g_cur_x   = msg->pose.pose.position.x;
        g_cur_y   = msg->pose.pose.position.y;
        g_cur_yaw = quatToYaw(qx, qy, qz, qw);
        g_pos_valid = true;
    }

    void executeQueue()
    {
        std::vector<Waypoint> waypoints;
        {
            std::lock_guard<std::mutex> lock(g_queue_mutex);
            if (g_waypoint_queue.empty()) {
                printf("[ERROR] Queue is empty. Draw arrows in RViz2 first.\n");
                return;
            }
            std::queue<Waypoint> tmp = g_waypoint_queue;
            while (!tmp.empty()) {
                waypoints.push_back(tmp.front());
                tmp.pop();
            }
            g_waypoint_queue = std::queue<Waypoint>();
        }

        int total = waypoints.size();
        printf("\n========================================\n");
        printf("EXECUTING %d waypoints automatically\n", total);
        for (int i = 0; i < total; i++) {
            printf("  [%d] x=%.4f  y=%.4f  yaw=%.1f deg\n",
                   i+1, waypoints[i].x, waypoints[i].y,
                   waypoints[i].yaw * 180.0 / M_PI);
        }
        printf("========================================\n\n");

        int pass_count = 0;
        for (int i = 0; i < total; i++) {
            executeAndLog(i+1, total,
                          waypoints[i].x,
                          waypoints[i].y,
                          waypoints[i].yaw,
                          pass_count);
        }

        printf("\n========================================\n");
        printf("QUEUE EXECUTION COMPLETE\n");
        printf("  Total waypoints : %d\n", total);
        printf("  Passed          : %d\n", pass_count);
        printf("  Failed          : %d\n", total - pass_count);
        printf("  WRR             : %.1f%%\n",
               (double)pass_count / total * 100.0);
        printf("  Results saved to: %s\n", g_csv_file.c_str());
        printf("========================================\n\n");
    }

    void goalCb(const geometry_msgs::msg::PoseStamped::SharedPtr msg)
    {
        double x   = msg->pose.position.x;
        double y   = msg->pose.position.y;
        double qx  = msg->pose.orientation.x;
        double qy  = msg->pose.orientation.y;
        double qz  = msg->pose.orientation.z;
        double qw  = msg->pose.orientation.w;
        double yaw = quatToYaw(qx, qy, qz, qw);

        if (queue_mode_) {
            std::lock_guard<std::mutex> lock(g_queue_mutex);
            g_waypoint_queue.push({x, y, yaw});
            int queue_size = g_waypoint_queue.size();
            saveQueueToFile();
            RCLCPP_INFO(this->get_logger(),
                "[QUEUED] Waypoint %d: x=%.3f y=%.3f yaw=%.1f deg | "
                "Total queued: %d | Press ENTER when done",
                queue_size, x, y, yaw * 180.0 / M_PI, queue_size);
        } else {
            waypoint_count_++;
            int wp_num = waypoint_count_;
            std::thread([this, x, y, yaw, wp_num]() mutable {
                executeAndLog(wp_num, wp_num, x, y, yaw, pass_count_);
            }).detach();
        }
    }

    rclcpp::Subscription<geometry_msgs::msg::PoseStamped>::SharedPtr goal_sub_;
    rclcpp::Subscription<nav_msgs::msg::Odometry>::SharedPtr odom_sub_;
    rclcpp::TimerBase::SharedPtr heartbeat_timer_;
};

// ============================================================
//  CLI Flag Parsing Helpers
// ============================================================

// Scan argv for --csv <path> and --json flags.
// Returns remaining positional args (flags stripped out).
static std::vector<std::string> parseFlags(int argc, char *argv[],
                                           bool &json_flag)
{
    std::vector<std::string> positional;
    json_flag = false;

    for (int i = 0; i < argc; i++) {
        std::string arg = argv[i];
        if (arg == "--csv" && i + 1 < argc) {
            g_csv_file = argv[++i];
        } else if (arg == "--json") {
            json_flag = true;
        } else {
            positional.push_back(arg);
        }
    }
    return positional;
}

// ============================================================
//  main()
// ============================================================
int main(int argc, char *argv[])
{
    // Parse global flags first (--csv, --json)
    bool json_flag = false;
    std::vector<std::string> args = parseFlags(argc, argv, json_flag);

    // Socket init
    g_fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (g_fd < 0) { perror("socket"); return -1; }

    memset(&g_addr, 0, sizeof(g_addr));
    g_addr.sin_family = AF_INET;
    g_addr.sin_port = htons(PORT);
    inet_pton(AF_INET, SERVER_IP, &g_addr.sin_addr);

    // No command → default bridge mode
    if (args.size() < 2) {
        rclcpp::init(argc, argv);
        rclcpp::spin(std::make_shared<GoalBridge>(false));
        rclcpp::shutdown();
        close(g_fd);
        return 0;
    }

    std::string cmd = args[1];

    // -- bridge ----------------------------------------------------------
    if (cmd == "bridge") {
        bool queue_mode = (args.size() >= 3 && args[2] == "queue");
        rclcpp::init(argc, argv);
        rclcpp::spin(std::make_shared<GoalBridge>(queue_mode));
        rclcpp::shutdown();
        close(g_fd);
        return 0;
    }

    // -- clearqueue ------------------------------------------------------
    if (cmd == "clearqueue") {
        remove(QUEUE_FILE);
        printf("[QUEUE] Cleared.\n");
        close(g_fd);
        return 0;
    }

    char buf[BUFFER_SIZE];

    // -- patrol ----------------------------------------------------------
    if (cmd == "patrol") {
        if (args.size() < 3) {
            printf("Usage: %s patrol <x,y,yaw> <x,y,yaw> ... [--csv path]\n", args[0].c_str());
            close(g_fd); return -1;
        }
        std::vector<Waypoint> waypoints;
        for (size_t i = 2; i < args.size(); i++) {
            Waypoint wp;
            if (parseWaypoint(args[i], wp)) {
                waypoints.push_back(wp);
            } else {
                printf("[ERROR] Could not parse waypoint: %s\n", args[i].c_str());
                close(g_fd); return -1;
            }
        }
        int total = waypoints.size();
        printf("\n========================================\n");
        printf("PATROL: %d waypoints\n", total);
        for (int i = 0; i < total; i++) {
            printf("  [%d] x=%.4f  y=%.4f  yaw=%.1f deg\n",
                   i+1, waypoints[i].x, waypoints[i].y,
                   waypoints[i].yaw * 180.0 / M_PI);
        }
        printf("========================================\n\n");

        // Need ROS for ODOM subscription
        rclcpp::init(argc, argv);
        auto node = std::make_shared<rclcpp::Node>("patrol_node");
        auto odom_sub = node->create_subscription<nav_msgs::msg::Odometry>(
            "/ODOM", 10,
            [](const nav_msgs::msg::Odometry::SharedPtr msg) {
                double qx = msg->pose.pose.orientation.x;
                double qy = msg->pose.pose.orientation.y;
                double qz = msg->pose.pose.orientation.z;
                double qw = msg->pose.pose.orientation.w;
                std::lock_guard<std::mutex> lock(g_pos_mutex);
                g_cur_x   = msg->pose.pose.position.x;
                g_cur_y   = msg->pose.pose.position.y;
                g_cur_yaw = quatToYaw(qx, qy, qz, qw);
                g_pos_valid = true;
            });

        // Spin ROS in background thread
        std::thread ros_thread([&node]() {
            rclcpp::spin(node);
        });

        initCSV();

        sendUDP(g_fd, g_addr,
            R"({"PatrolDevice":{"Type":100,"Command":100,"Time":"2025-01-01 00:00:00","Items":{}}})");
        usleep(300000);
        sendUDP(g_fd, g_addr,
            R"({"PatrolDevice":{"Type":1101,"Command":5,"Time":"2025-01-01 00:00:00","Items":{"Mode":1}}})");
        usleep(1000000);

        int pass_count = 0;
        for (int i = 0; i < total; i++) {
            executeAndLog(i+1, total,
                          waypoints[i].x,
                          waypoints[i].y,
                          waypoints[i].yaw,
                          pass_count);
        }

        printf("\n========================================\n");
        printf("PATROL COMPLETE\n");
        printf("  Total waypoints : %d\n", total);
        printf("  Passed          : %d\n", pass_count);
        printf("  Failed          : %d\n", total - pass_count);
        printf("  WRR             : %.1f%%\n",
               (double)pass_count / total * 100.0);
        printf("  Results saved to: %s\n", g_csv_file.c_str());
        printf("========================================\n\n");

        rclcpp::shutdown();
        ros_thread.join();
    }
    // -- nav -------------------------------------------------------------
    else if (cmd == "nav") {
        if (args.size() < 4) {
            printf("Usage: %s nav <x> <y> [yaw]\n", args[0].c_str());
            close(g_fd); return -1;
        }
        float x   = atof(args[2].c_str());
        float y   = atof(args[3].c_str());
        float yaw = (args.size() > 4) ? atof(args[4].c_str()) : 0.0f;
        printf("Target: x=%.4f y=%.4f yaw=%.4f\n\n", x, y, yaw);
        sendUDP(g_fd, g_addr,
            R"({"PatrolDevice":{"Type":100,"Command":100,"Time":"2025-01-01 00:00:00","Items":{}}})");
        usleep(300000);
        sendUDP(g_fd, g_addr,
            R"({"PatrolDevice":{"Type":1101,"Command":5,"Time":"2025-01-01 00:00:00","Items":{"Mode":1}}})");
        usleep(1000000);
        snprintf(buf, sizeof(buf),
            R"({"PatrolDevice":{"Type":1003,"Command":1,"Time":"2025-01-01 00:00:00","Items":{"Value":1,"MapID":0,"PosX":%.6f,"PosY":%.6f,"PosZ":0.0,"AngleYaw":%.6f,"PointInfo":1,"Gait":12290,"Speed":1,"Manner":0,"ObsMode":0,"NavMode":1}}})",
            x, y, yaw);
        sendUDP(g_fd, g_addr, buf);
        usleep(500000);
        sendUDP(g_fd, g_addr,
            R"({"PatrolDevice":{"Type":1007,"Command":1,"Time":"2025-01-01 00:00:00","Items":{}}})");
        usleep(200000);
        sendUDP(g_fd, g_addr,
            R"({"PatrolDevice":{"Type":1007,"Command":2,"Time":"2025-01-01 00:00:00","Items":{}}})");
        printf("\nListening for responses (5s)...\n\n");
        listenResponses(g_fd, 5);
    }
    // -- status ----------------------------------------------------------
    else if (cmd == "status") {
        sendUDP(g_fd, g_addr,
            R"({"PatrolDevice":{"Type":100,"Command":100,"Time":"2025-01-01 00:00:00","Items":{}}})");
        usleep(200000);
        sendUDP(g_fd, g_addr,
            R"({"PatrolDevice":{"Type":1007,"Command":1,"Time":"2025-01-01 00:00:00","Items":{}}})");
        printf("Querying nav status...\n\n");
        listenResponses(g_fd, 3);
    }
    // -- loc (with optional --json) --------------------------------------
    else if (cmd == "loc") {
        sendUDP(g_fd, g_addr,
            R"({"PatrolDevice":{"Type":100,"Command":100,"Time":"2025-01-01 00:00:00","Items":{}}})");
        usleep(200000);
        sendUDP(g_fd, g_addr,
            R"({"PatrolDevice":{"Type":1007,"Command":2,"Time":"2025-01-01 00:00:00","Items":{}}})");
        if (json_flag) {
            listenResponsesJSON(g_fd, 3);
        } else {
            printf("Querying location...\n\n");
            listenResponses(g_fd, 3);
        }
    }
    // -- cancel ----------------------------------------------------------
    else if (cmd == "cancel") {
        sendUDP(g_fd, g_addr,
            R"({"PatrolDevice":{"Type":1004,"Command":1,"Time":"2025-01-01 00:00:00","Items":{}}})");
        printf("Cancelling nav task...\n\n");
        listenResponses(g_fd, 3);
    }
    // -- monitor ---------------------------------------------------------
    else if (cmd == "monitor") {
        printf("Monitoring robot state (Ctrl+C to stop)...\n\n");
        while (true) {
            sendUDP(g_fd, g_addr,
                R"({"PatrolDevice":{"Type":100,"Command":100,"Time":"2025-01-01 00:00:00","Items":{}}})");
            usleep(200000);
            sendUDP(g_fd, g_addr,
                R"({"PatrolDevice":{"Type":1007,"Command":1,"Time":"2025-01-01 00:00:00","Items":{}}})");
            usleep(200000);
            sendUDP(g_fd, g_addr,
                R"({"PatrolDevice":{"Type":1007,"Command":2,"Time":"2025-01-01 00:00:00","Items":{}}})");
            listenResponses(g_fd, 2);
            printf("---\n");
        }
    }
    // -- heartbeat -------------------------------------------------------
    else if (cmd == "heartbeat") {
        sendUDP(g_fd, g_addr,
            R"({"PatrolDevice":{"Type":100,"Command":100,"Time":"2025-01-01 00:00:00","Items":{}}})");
        listenResponses(g_fd, 3);
    }
    // -- stand -----------------------------------------------------------
    else if (cmd == "stand") {
        sendUDP(g_fd, g_addr,
            R"({"PatrolDevice":{"Type":2,"Command":22,"Time":"2025-01-01 00:00:00","Items":{"MotionParam":1}}})");
        printf("Sent: stand\n"); listenResponses(g_fd, 3);
    }
    // -- sit -------------------------------------------------------------
    else if (cmd == "sit") {
        sendUDP(g_fd, g_addr,
            R"({"PatrolDevice":{"Type":2,"Command":22,"Time":"2025-01-01 00:00:00","Items":{"MotionParam":4}}})");
        printf("Sent: sit\n"); listenResponses(g_fd, 3);
    }
    // -- estop -----------------------------------------------------------
    else if (cmd == "estop") {
        sendUDP(g_fd, g_addr,
            R"({"PatrolDevice":{"Type":2,"Command":22,"Time":"2025-01-01 00:00:00","Items":{"MotionParam":2}}})");
        printf("Sent: estop\n"); listenResponses(g_fd, 3);
    }
    // -- nav_mode --------------------------------------------------------
    else if (cmd == "nav_mode") {
        sendUDP(g_fd, g_addr,
            R"({"PatrolDevice":{"Type":1101,"Command":5,"Time":"2025-01-01 00:00:00","Items":{"Mode":1}}})");
        printf("Sent: nav_mode\n"); listenResponses(g_fd, 3);
    }
    // -- regular_mode ----------------------------------------------------
    else if (cmd == "regular_mode") {
        sendUDP(g_fd, g_addr,
            R"({"PatrolDevice":{"Type":1101,"Command":5,"Time":"2025-01-01 00:00:00","Items":{"Mode":0}}})");
        printf("Sent: regular_mode\n"); listenResponses(g_fd, 3);
    }
    // -- gait_flat -------------------------------------------------------
    else if (cmd == "gait_flat") {
        sendUDP(g_fd, g_addr,
            R"({"PatrolDevice":{"Type":2,"Command":23,"Time":"2025-01-01 00:00:00","Items":{"GaitParam":12290}}})");
        printf("Sent: gait_flat\n"); listenResponses(g_fd, 3);
    }
    // -- gait_stair ------------------------------------------------------
    else if (cmd == "gait_stair") {
        sendUDP(g_fd, g_addr,
            R"({"PatrolDevice":{"Type":2,"Command":23,"Time":"2025-01-01 00:00:00","Items":{"GaitParam":13}}})");
        printf("Sent: gait_stair\n"); listenResponses(g_fd, 3);
    }
    // -- unknown ---------------------------------------------------------
    else {
        printf("Unknown command: %s\n", args[1].c_str());
        printUsage(args[0].c_str());
        close(g_fd); return -1;
    }

    close(g_fd);
    return 0;
}
