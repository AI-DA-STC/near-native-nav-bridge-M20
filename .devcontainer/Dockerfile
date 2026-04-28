FROM osrf/ros:foxy-desktop

# Install useful tools
RUN apt-get update && apt-get install -y \
    python3-pip \
    python3-colcon-common-extensions \
    python3-rosdep \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt
RUN pip3 install --no-cache-dir -r /tmp/requirements.txt

# Auto-source ROS2 every terminal
RUN echo "source /opt/ros/foxy/setup.bash" >> /root/.bashrc