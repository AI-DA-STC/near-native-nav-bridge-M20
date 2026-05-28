# Multi-robot M20 DDS stack setup

Setup guide for running multiple DeepRobotics M20 robots on a shared network with ROS 2 Foxy DDS discovery.

## Prerequisites

- A WiFi router accessible to all robots and the laptop
- Router SSID and password (e.g. `SSID` / `password`)
- SSH access to each robot's AOS (10.21.31.103) via the robot's own 5G AP
- Laptop with Docker and VS Code (with Dev Containers extension)

## IP assignment scheme

| Device         | Interface | Static IP       |
|----------------|-----------|-----------------|
| Router         | —         | 192.168.8.1     |
| Laptop         | wlan0     | 192.168.8.10    |
| Robot 741 (AOS)  | p2p0      | 192.168.8.101   |
| Robot 738 (AOS)  | p2p0      | 192.168.8.102   |
| Robot 665 (AOS)  | p2p0      | 192.168.8.103   | 

All devices use `ROS_DOMAIN_ID=0`.

---

## Part 1 — Robot-side setup

Repeat for each robot. SSH in via the robot's own 5G AP first.

```bash
ssh user@10.21.33.103
```

### 1.1 Disable robot AP mode 

Modify vim /etc/NetworkManager/NetworkManager.conf and delete unmanaged-devices and all the [keyfile] section and reboot.

### 1.2 Connect to the router WiFi

Scan for available networks:

```bash
nmcli d wifi list
```

Connect using the BSSID if the SSID has special characters or spaces:

```bash
sudo nmcli d wifi connect "near-robots-2.4G" password "enter_password" ifname p2p0
```

**Test:** Verify the connection:

```bash
nmcli con show --active
# Should show "SSID" as active
```

### 1.3 Assign a static IP

Replace `192.168.8.101` with the IP for this specific robot.

```bash
sudo nmcli con modify "near-robots-2.4G" ipv4.addresses 192.168.8.101/24
sudo nmcli con modify "near-robots-2.4G" ipv4.gateway 192.168.8.1
sudo nmcli con modify "near-robots-2.4G" ipv4.method manual
sudo nmcli con up "near-robots-2.4G"
```

If the connection name doesn't match the SSID, find it with `nmcli con show` and use the exact `NAME` value (in quotes) or the `UUID`.

**Test:** Verify the static IP:

```bash
ifconfig p2p0
# Should show inet 192.168.8.101
```

### 1.4 Create the FastDDS profile

This pins DDS discovery to the router-facing interface so it doesn't multicast on the internal 10.21.x.x interfaces.

```bash
cat > ~/fastdds_profile.xml << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<profiles xmlns="http://www.eprosima.com/XMLSchemas/fastRTPS_Profiles">
  <transport_descriptors>
    <transport_descriptor>
      <transport_id>custom_udp</transport_id>
      <type>UDPv4</type>
      <interfaceWhiteList>
        <address>127.0.0.1</address>
        <address>10.21.31.103</address>     <!-- eth3: to NOS -->
        <address>192.168.8.101</address>    <!-- p2p0: to laptop -->
      </interfaceWhiteList>
    </transport_descriptor>
    <transport_descriptor>
      <transport_id>custom_shm</transport_id>
      <type>SHM</type>
    </transport_descriptor>
  </transport_descriptors>
  <participant profile_name="default_profile" is_default_profile="true">
    <rtps>
      <userTransports>
        <transport_id>custom_shm</transport_id>
        <transport_id>custom_udp</transport_id>
      </userTransports>
      <useBuiltinTransports>false</useBuiltinTransports>
    </rtps>
  </participant>
</profiles>

EOF
```

> **Important:** Change the `<address>` to match this robot's static IP (e.g. `192.168.8.102` for robot 2).

### 1.5 Export environment variables

```bash
export FASTRTPS_DEFAULT_PROFILES_FILE=~/fastdds_profile.xml
export ROS_DOMAIN_ID=0
```

To make this persist across reboots, add to `~/.bashrc`:

```bash
echo 'export FASTRTPS_DEFAULT_PROFILES_FILE=~/fastdds_profile.xml' >> ~/.bashrc
echo 'export ROS_DOMAIN_ID=0' >> ~/.bashrc
```

**Test:** Publish a dummy topic to verify everything is running:

```bash
ros2 topic pub /test_robot1 std_msgs/msg/String "data: 'hello from robot 1'" --once
```

---

## Part 2 — Laptop-side setup

### 2.1 Connect to the router and set static IP

Connect your laptop to the `SSID` WiFi network, then assign a static IP:

```bash
sudo nmcli con modify "near-robots-2.4G" ipv4.addresses 192.168.8.10/24
sudo nmcli con modify "near-robots-2.4G" ipv4.gateway 192.168.8.1
sudo nmcli con modify "near-robots-2.4G" ipv4.method manual
sudo nmcli con up "near-robots-2.4G"
```

**Test:** Verify the IP:

```bash
ifconfig wlp131s0f0
# Should show inet 192.168.8.10
```

### 2.2 Project structure

```
root/
├── .devcontainer/
│   ├── devcontainer.json
│   └── Dockerfile
└── fastdds_profile.xml
└── ...
```

### 2.3 Dockerfile (Example only) Dpends on your docker setup

```dockerfile
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
```

### 2.4 devcontainer.json

The `--network=host` flag is critical — without it, the Docker container is isolated on a bridge network and DDS multicast cannot reach the robots.

```jsonc
{
  "name": "ROS2 Foxy",
  "build": {
    "dockerfile": "Dockerfile",
    "context": ".."
  },
  "customizations": {
    "vscode": {
      "extensions": [
        "ms-python.python",
        "ms-iot.vscode-ros",
        "twxs.cmake",
        "ms-vscode.cmake-tools"
      ],
      "settings": {
        "terminal.integrated.defaultProfile.linux": "bash",
        "ros.distro": "foxy"
      }
    }
  },
  "mounts": [
    "source=${localWorkspaceFolder},target=/root/ros2_ws/src/nav_cmd_bridge,type=bind"
  ],
  "runArgs": ["--network=host"],
  "workspaceFolder": "/root/ros2_ws/src/nav_cmd_bridge",
  "postCreateCommand": "rosdep update"
}
```

### 2.5 Create the FastDDS profile

Create `config/fastdds_profile.xml` in your project:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<profiles xmlns="http://www.eprosima.com/XMLSchemas/fastRTPS_Profiles">
  <transport_descriptors>
    <transport_descriptor>
      <transport_id>custom_udp</transport_id>
      <type>UDPv4</type>
      <interfaceWhiteList>
        <address>192.168.8.10</address>
      </interfaceWhiteList>
    </transport_descriptor>
  </transport_descriptors>
  <participant profile_name="default_profile" is_default_profile="true">
    <rtps>
      <userTransports>
        <transport_id>custom_udp</transport_id>
      </userTransports>
      <useBuiltinTransports>false</useBuiltinTransports>
    </rtps>
  </participant>
</profiles>
```

### 2.6 Build and open the dev container

Open the project folder in VS Code, then run:

> **Ctrl+Shift+P** → "Dev Containers: Rebuild and Reopen in Container"

Or from the command line:

```bash
docker build -t ros2-foxy-nav -f .devcontainer/Dockerfile .
docker run --network=host -it \
  -v $(pwd):/root/ros2_ws/src/nav_cmd_bridge \
  ros2-foxy-nav bash
```

### 2.7 Export environment variables inside the container

```bash
export ROS_DOMAIN_ID=0
export FASTRTPS_DEFAULT_PROFILES_FILE=/root/ros2_ws/src/nav_cmd_bridge/fastdds_profile.xml
```

To make this automatic, add to the Dockerfile:

```dockerfile
ENV ROS_DOMAIN_ID=10
ENV FASTRTPS_DEFAULT_PROFILES_FILE=/root/ros2_ws/src/nav_cmd_bridge/config/fastdds_profile.xml
```

---

## Part 3 — Verification tests

Run these in order from inside the Docker container on your laptop.

### Test 1: Ping the robot

```bash
ping 192.168.8.101
```

**Expected:** Replies with low latency. If this fails, the network is not configured correctly — go back to Parts 1 and 2.

### Test 2: Multicast send/receive

On the laptop (inside Docker):

```bash
ros2 multicast receive
```

On the robot (in a separate SSH session):

```bash
export ROS_DOMAIN_ID=10
export FASTRTPS_DEFAULT_PROFILES_FILE=~/fastdds_profile.xml
ros2 multicast send
```

**Expected:** The laptop terminal prints received multicast packets. If nothing appears, either the FastDDS profiles are not set or the router is blocking multicast. See the troubleshooting section below.

### Test 3: Topic discovery

On the robot:

```bash
ros2 topic pub /test_robot1 std_msgs/msg/String "data: 'hello from robot 1'"
```

On the laptop:

```bash
ros2 topic list
```

**Expected:** `/test_robot1` appears in the list.

```bash
ros2 topic echo /test_robot1
```

**Expected:** Prints `data: 'hello from robot 1'` messages.

### Test 4: Multi-robot discovery (repeat for each robot)

With all robots configured and publishing their own test topics:

```bash
ros2 topic list
```

**Expected:** `/test_robot1`, `/test_robot2`, `/test_robot3` all visible from the laptop.

---



On the robot side 

export ROS_DOMAIN_ID=0
export FASTRTPS_DEFAULT_PROFILES_FILE=/home/user/fastdds_profile.xml
cd workspace/ros2_ws
source install/setup.bash
ros2 launch nav_cmd_bridge relays.launch.py


On the laptop side
export ROS_DOMAIN_ID=0
export FASTRTPS_DEFAULT_PROFILES_FILE=/root/ros2_ws/src/nav_cmd_bridge/fastdds_profile.xml
cd ~/ros2_ws
source install/setup.bash
ros2 run nav_cmd_bridge tfmessage_relay --ros-args -p input_topic:=/tf_relayed -p output_topic:=/tf &
ros2 run nav_cmd_bridge tfmessage_relay --ros-args \
  -p input_topic:=/tf_static_relayed -p output_topic:=/tf_static \
  -p durability:=transient_local &

in another terminal run the above exports, then 
rviz2 &

ros2 run nav_cmd_bridge nav_cmd_bridge --ip 192.168.8.103 bridge
ros2 run nav_cmd_bridge nav_cmd_bridge patrol --ip 192.168.8.103 -3.20162,-3.81141,-0.0404694 -1.72499,-3.88239,0.0412739 0.200177,-1.78368,0.00477056
