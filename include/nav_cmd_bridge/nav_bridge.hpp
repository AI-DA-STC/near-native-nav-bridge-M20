#ifndef NAV_CMD_BRIDGE__NAV_BRIDGE_HPP_
#define NAV_CMD_BRIDGE__NAV_BRIDGE_HPP_

#include <string>
#include <cstdint>
#include <cmath>
#include <queue>
#include <mutex>
#include <vector>

// ============================================================
//  Network & Protocol Constants
// ============================================================
#define SERVER_IP       "10.21.31.103"
#define PORT            30000
#define BUFFER_SIZE     2048

// ============================================================
//  Navigation Thresholds
// ============================================================
#define SETTLE_THRESHOLD  0.1      // metres – waypoint arrival (strict benchmark)
#define LCE_THRESHOLD     0.15     // metres – SLAM loop-closure error
#define YAW_THRESHOLD     5.0      // degrees – SLAM heading drift

// ============================================================
//  Default File Paths
// ============================================================
// Relative to the current working directory (typically the project root)
#define DEFAULT_CSV_FILE  "./assets/outputs/navigation_results.csv"
#define QUEUE_FILE        "/tmp/nav_waypoint_queue.txt"

// ============================================================
//  Data Types
// ============================================================
struct udpMessage {
    unsigned char header[16];
    unsigned char data[BUFFER_SIZE];
};

struct Waypoint {
    double x   = 0.0;
    double y   = 0.0;
    double yaw = 0.0;
};

// ============================================================
//  Global State  (defined in nav_bridge_node.cpp)
// ============================================================
extern unsigned short g_msgId;
extern int            g_fd;
extern struct sockaddr_in g_addr;

extern std::queue<Waypoint> g_waypoint_queue;
extern std::mutex           g_queue_mutex;

extern std::mutex g_pos_mutex;
extern double     g_cur_x;
extern double     g_cur_y;
extern double     g_cur_yaw;
extern bool       g_pos_valid;

// Runtime-configurable CSV path (set from --csv flag, else DEFAULT_CSV_FILE)
extern std::string g_csv_file;

// ============================================================
//  Utility Functions
// ============================================================
std::string jsonGet(const std::string &json, const std::string &key);
std::string getTimestamp();
double      quatToYaw(double x, double y, double z, double w);
bool        parseWaypoint(const std::string &s, Waypoint &wp);

// ============================================================
//  Status / Error String Lookups
// ============================================================
inline const char* navStatusStr(int status) {
    switch (status) {
        case 0:    return "Idle";
        case 1:    return "Exiting charging station";
        case 2:    return "Navigation preprocessing";
        case 3:    return "Navigating";
        case 4:    return "Navigation complete";
        case 5:    return "Entering charging dock";
        case 0xff: return "Paused";
        default:   return "Unknown";
    }
}

inline const char* navErrorStr(int code) {
    switch (code) {
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
        case 0xA343: return "Failed to exit charging dock";
        case 0xA345: return "Charging execution failed";
        case 0xA34B: return "Persistent obstacle stop";
        case 0xA34C: return "Global planning failure";
        case 0xA34D: return "Nav speed not updated";
        case 0xA34E: return "Task failed during charging";
        case 57351:  return "No operation permission";
        default:     return "Unknown error";
    }
}

inline const char* motionStateStr(int state) {
    switch (state) {
        case 0:  return "Idle";
        case 1:  return "Stand";
        case 2:  return "Soft Emergency Stop";
        case 3:  return "Power-on Damping";
        case 4:  return "Sitting";
        case 6:  return "Standard Motion";
        case 8:  return "Agile Motion";
        case 17: return "RL Control";
        default: return "Unknown";
    }
}

// ============================================================
//  UDP Communication
// ============================================================
int  sendUDP(int fd, struct sockaddr_in &addr, const char *json);
void listenResponses(int fd, int seconds);
void processResponse(const std::string &payload);

// ============================================================
//  CSV Logging
// ============================================================
void initCSV();
void logToCSV(int wp_num,
              double goal_x,  double goal_y,  double goal_yaw,
              double actual_x, double actual_y, double actual_yaw,
              double distance, double heading_err_deg,
              bool nav_completed, bool pass);

// ============================================================
//  Navigation Execution
// ============================================================
bool waitForArrival(int timeoutSeconds, double goal_x, double goal_y);
bool executeAndLog(int wp_num, int total,
                   double goal_x, double goal_y, double goal_yaw,
                   int &pass_count);

// ============================================================
//  Queue Helpers
// ============================================================
void saveQueueToFile();
void printUsage(const char *prog);

#endif  // NAV_CMD_BRIDGE__NAV_BRIDGE_HPP_
