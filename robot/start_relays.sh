#!/usr/bin/env bash
# Start all relays for this robot in the background (logs in /tmp/relays*.log).
#   /root/start_relays.sh          start (restarts if running)
#   /root/start_relays.sh stop
ROBOT_ID=${ROBOT_ID:-834}
source /opt/ros/foxy/setup.bash
source /root/ros2_ws/install/setup.bash
export ROBOT_ID ROS_DOMAIN_ID=0 FASTRTPS_DEFAULT_PROFILES_FILE=/root/fastdds_relay.xml
pkill -INT -f "ros2 launch nav_cmd_bridge relays"
pkill -INT -f "initialpose_set_relay_"
pkill -INT -f "matching_error_relay_"
sleep 2
[ "$1" = stop ] && exit 0

LAUNCH="$(ros2 pkg prefix nav_cmd_bridge)/share/nav_cmd_bridge/launch/relays.launch.py"
nohup ros2 launch nav_cmd_bridge relays.launch.py > /tmp/relays.log 2>&1 &

# Relays added to relays.launch.py after this image was built; started by hand here.
if ! grep -q initialpose_set "$LAUNCH"; then
  nohup ros2 run nav_cmd_bridge posewithcov_relay --ros-args -r __node:=initialpose_set_relay_${ROBOT_ID} \
    -p input_topic:=/initialpose_set_relayed_${ROBOT_ID} -p output_topic:=/initialpose \
    > /tmp/relays_initialpose_set.log 2>&1 &
fi
if ! grep -q matching_error "$LAUNCH"; then
  nohup ros2 run nav_cmd_bridge float64multiarray_relay --ros-args -r __node:=matching_error_relay_${ROBOT_ID} \
    -p input_topic:=/LOCATION_STATUS/MATCHING_ERROR \
    -p output_topic:=/LOCATION_STATUS/MATCHING_ERROR_relayed_${ROBOT_ID} \
    > /tmp/relays_matching_error.log 2>&1 &
fi
sleep 6
grep -hE "Relay:|died|bad_alloc|XMLPARSER" /tmp/relays*.log
