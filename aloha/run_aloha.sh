#!/bin/bash
# The Aloha's part of the demo: drive to the box (demo/waypoints/aloha.json) with send_goal.py and dock precisely onto
# it, then go through the arm poses taught there with teach_manipulator.sh (demo/waypoints/manipulator.json) at
# 0.5 rad/s, 1 s at each. The arms only move once the Aloha has docked. Needs aloha/bridge.sh, the robot's navigation,
# dock.py and start_ms_piper.launch with mode:=1 auto_enable:=true (robot/start_aloha.sh starts them). Files go in
# WAYPOINTS (default demo/waypoints). Ctrl+C stops it.
source /opt/ros/foxy/setup.bash
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WAYPOINTS=${WAYPOINTS:-$HERE/../demo/waypoints}
for file in aloha manipulator; do
    if [[ ! -f $WAYPOINTS/$file.json ]]; then
        echo "No $WAYPOINTS/$file.json" >&2
        exit 1
    fi
done
trap 'exit 130' INT  # also after send_goal.py, which exits 0 on Ctrl+C

echo -e "\n=== Aloha: drive to the box ===\n"
ROS_DOMAIN_ID=1 python3 "$HERE/send_goal.py" "$WAYPOINTS/aloha.json" --dock
echo -e "\n=== Aloha: arm poses ===\n"
"$HERE/run_manipulator.sh" "$WAYPOINTS/manipulator.json" --speed 0.5 --pause 1.0
