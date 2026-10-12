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

# The demo's box detector (demo/detect_box.py, YOLO26 from external/lynx-M20-yolo), on CPU
COPY demo/requirements-detect.txt /tmp/requirements-detect.txt
RUN pip3 install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==2.4.1 torchvision==0.19.1 \
    && pip3 install --no-cache-dir -r /tmp/requirements-detect.txt

# ros1_bridge with the Aloha's piper_msgs, for aloha/bridge.sh
COPY aloha/piper_msgs /tmp/aloha/piper_msgs
COPY aloha/build_bridge.sh /tmp/aloha/build_bridge.sh
RUN /tmp/aloha/build_bridge.sh && rm -rf /tmp/aloha /opt/aloha_bridge/build_* /opt/aloha_bridge/devel_ros1

# Auto-source ROS2 (and the Aloha's piper_msgs) every terminal
RUN echo "source /opt/ros/foxy/setup.bash" >> /root/.bashrc \
    && echo "source /opt/aloha_bridge/ros2/setup.bash" >> /root/.bashrc