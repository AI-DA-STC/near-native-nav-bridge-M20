FROM osrf/ros:foxy-desktop

RUN echo "deb http://snapshots.ros.org/noetic/final/ubuntu focal main" > /etc/apt/sources.list.d/ros1-snapshots.list

# Install useful tools
RUN apt-get update && apt-get install -y \
    python3-pip \
    python3-colcon-common-extensions \
    python3-rosdep \
    git \
    curl \
    ros-foxy-ros1-bridge \
    ros-foxy-compressed-image-transport \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt
RUN pip3 install --no-cache-dir -r /tmp/requirements.txt

# ros1_bridge with the Aloha's piper_msgs, for aloha/bridge.sh
COPY aloha/piper_msgs /tmp/aloha/piper_msgs
COPY aloha/build_bridge.sh /tmp/aloha/build_bridge.sh
RUN /tmp/aloha/build_bridge.sh && rm -rf /tmp/aloha /opt/aloha_bridge/build_* /opt/aloha_bridge/devel_ros1

# Node.js LTS and npm for the operator's Command Center (frontend/), from nodejs.org: focal's nodejs is too old for Vite
ARG NODE_VERSION=24.21.0
RUN cd /tmp \
    && curl -fsSLO https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz \
    && curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt \
       | grep " node-v${NODE_VERSION}-linux-x64.tar.gz\$" | sha256sum -c - \
    && tar -xzf node-v${NODE_VERSION}-linux-x64.tar.gz -C /usr/local --strip-components=1 --no-same-owner \
    && rm node-v${NODE_VERSION}-linux-x64.tar.gz \
    && node --version && npm --version

# Auto-source ROS2 (and the Aloha's piper_msgs) every terminal
RUN echo "source /opt/ros/foxy/setup.bash" >> /root/.bashrc \
    && echo "source /opt/aloha_bridge/ros2/setup.bash" >> /root/.bashrc