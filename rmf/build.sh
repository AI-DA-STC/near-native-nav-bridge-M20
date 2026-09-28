#!/usr/bin/env bash
# Build the Jazzy RMF workspace. Output goes to /ws, not the repo: the repo root is the
# Foxy nav_cmd_bridge package and its build/ install/ log/ must not be clobbered.
set -e
source /opt/ros/jazzy/setup.bash
cd /ws
colcon build --symlink-install --base-paths /repo/rmf "$@"
