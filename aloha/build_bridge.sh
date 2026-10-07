#!/bin/bash
# Build ros1_bridge from source with the Aloha's piper_msgs (the apt ros1_bridge only knows the standard messages),
# into ALOHA_BRIDGE (default /opt/aloha_bridge). bridge.sh uses it once it is there. Takes ~10 min.
set -eo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WS=${ALOHA_BRIDGE:-/opt/aloha_bridge}
mkdir -p "$WS/src"

# piper_msgs for ROS 1, then ROS 2
(source /opt/ros/noetic/setup.bash
 catkin_make_isolated --source "$HERE/piper_msgs/ros1" --build "$WS/build_ros1" --devel "$WS/devel_ros1" \
     --install --install-space "$WS/ros1")
(source /opt/ros/foxy/setup.bash
 colcon build --base-paths "$HERE/piper_msgs/ros2" --build-base "$WS/build_ros2" --install-base "$WS/ros2")

# ros1_bridge, at the version apt installs, against both
[[ -d $WS/src/ros1_bridge ]] || git clone -b 0.9.7 --depth 1 https://github.com/ros2/ros1_bridge.git "$WS/src/ros1_bridge"
(source /opt/ros/noetic/setup.bash
 source "$WS/ros1/setup.bash"
 source /opt/ros/foxy/setup.bash
 source "$WS/ros2/setup.bash"
 colcon build --base-paths "$WS/src" --build-base "$WS/build_bridge" --install-base "$WS/bridge" --cmake-force-configure)

source "$WS/bridge/setup.bash"
pairs=$(ros2 run ros1_bridge dynamic_bridge --print-pairs)
[[ $pairs == *piper_msgs/msg/PiperStatusMsg* && $pairs == *piper_msgs/msg/PosCmd* ]] \
    || { echo "ros1_bridge was built without piper_msgs" >&2; exit 1; }
echo "ros1_bridge with piper_msgs is in $WS/bridge"
