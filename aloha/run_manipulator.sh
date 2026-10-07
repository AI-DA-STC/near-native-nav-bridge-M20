#!/bin/bash
# Drive the Aloha's arms through the poses saved by teach_manipulator.sh, by sending /master/joint_left and
# /master/joint_right. Usage: aloha/run_manipulator.sh [poses.json] [--speed RAD_PER_S] [--pause S]
# (default demo/waypoints/manipulator.json, 0.5 rad/s, 1 s). Needs aloha/bridge.sh, and start_ms_piper.launch on the
# robot with mode:=1 auto_enable:=true. Ctrl+C stops the arms where they are.
source /opt/ros/foxy/setup.bash
export ROS_DOMAIN_ID=1
exec python3 "$(dirname "$0")/manipulator.py" run "$@"
