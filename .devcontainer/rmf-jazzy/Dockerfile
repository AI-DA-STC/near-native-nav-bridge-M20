# Open-RMF (ROS 2 Jazzy) side of the stack: RMF core, M20 fleet adapter, mission runner.
# Laptop only. The robots stay on Foxy; this container reads their relayed
# /ODOM_relayed_<id> over DDS (Foxy->Jazzy verified for nav_msgs/Odometry) and
# commands them over the vendor UDP API, so no ROS traffic goes back to them.
FROM ros:jazzy-ros-base

RUN apt-get update && apt-get install -y --no-install-recommends \
      ros-jazzy-rmf-fleet-adapter \
      ros-jazzy-rmf-fleet-adapter-python \
      ros-jazzy-rmf-task-ros2 \
      ros-jazzy-rmf-traffic-ros2 \
      ros-jazzy-rmf-building-map-tools \
      ros-jazzy-rmf-demos-tasks \
      ros-jazzy-rmf-visualization \
      ros-jazzy-rviz2 \
      python3-websockets \
      python3-yaml \
      python3-pytest \
      python3-colcon-common-extensions \
    && rm -rf /var/lib/apt/lists/*

# The repo root is itself the Foxy package, so the Jazzy workspace lives outside it
# (/ws) and builds only rmf/ via --base-paths; see rmf/README.md.
RUN mkdir -p /ws && \
    echo "source /opt/ros/jazzy/setup.bash" >> /root/.bashrc && \
    echo "[ -f /ws/install/setup.bash ] && source /ws/install/setup.bash" >> /root/.bashrc && \
    echo "export PATH=/ws/install/m20_rmf/lib/m20_rmf:\$PATH" >> /root/.bashrc
