#!/bin/bash
# Teach the Aloha's arm poses: move the arms (with the master arms, start_ms_piper.launch mode:=0) and press ENTER to
# save both puppet arms' joint positions, u + ENTER to drop the last pose, q + ENTER to finish.
# Usage: aloha/teach_manipulator.sh [poses.json]  (default demo/waypoints/manipulator.json). Needs aloha/bridge.sh.
source /opt/ros/foxy/setup.bash
export ROS_DOMAIN_ID=1
exec python3 "$(dirname "$0")/manipulator.py" teach "$@"
