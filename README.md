# nav_cmd_bridge

Navigation command bridge for DeepRobotics M20 Pro. Sends waypoints over UDP and subscribes to `/ODOM` for position tracking. Supports RViz2-driven navigation and structured benchmark testing (T1–T4).

# Docker build and push instructions from workstation (ignore for now)

The robot is arm64, the laptop is x86, so the image is cross-built on the laptop and pushed
through a plain-HTTP registry running on the laptop itself.

## One-time setup only

QEMU emulators (cross-building arm64 on x86; resets on reboot unless persisted):
```bash
docker run --privileged --rm tonistiigi/binfmt --install arm64
```

buildx builder (the default docker driver can't cross-build reliably):
```bash
docker buildx create --name multiarch --driver docker-container --use --bootstrap
```

A local image registry on the laptop (persists across reboots):
```bash
docker run -d --restart=always -p 5001:5000 --name demo_navigation_stack registry:2
```

## Build and push (on laptop)

```bash
docker buildx build --platform linux/arm64 -f Dockerfile.deploy -t m20-bridge:foxy --load .
docker tag  m20-bridge:foxy localhost:5000/m20-bridge:foxy   # localhost = auto-insecure, no config
docker push localhost:5000/m20-bridge:foxy                   # progress + only changed layers
```

# Docker pull instructions in robot

Connect to "near-robots-5G" and make sure to set a static ip for the robot as per the following: 

router gateway : 192.168.123.1
Main Workstation : 192.168.123.160
Robot 741 : 192.168.123.100
Robot 665 : 192.168.123.101
Robot 834 : 192.168.123.102

On **robot**, trust the laptop's plain-HTTP registry, then restart docker:
```bash
# /etc/docker/daemon.json   (<WS_IP> = laptop's address on the 10.21.31.x LAN)
{ "insecure-registries": ["192.168.123.160:5000"] }
sudo systemctl restart docker

```bash
docker pull --platform linux/arm64 192.168.123.160:5000/m20-bridge:foxy
docker tag  192.168.123.160:5000/m20-bridge:foxy m20-bridge:foxy     # restore the clean name
```

# localization on robot

- Step 1 : Connect to the router WiFi "near-robots-5G" 
- Step 2 : SSH into the robot like so : 
```bash
ssh user@192.168.8.101, password = ' (single quote)
```
- Step 3 : Robot localization verification

ensure robot is localized on the preloaded SLAM map by running the following on the robot
```bash
su
source /opt/ros/foxy/setup.bash
rviz2
```
- on the rviz, look for the 3D ODOM position of the robot, it should somewhat reflect its current position. 
If it is drifting, select "2D Pose Estimate", then click and extend the arrow to set the location and heading.
- After the robot relozalises, close and save rviz

  **Faster alternative (no `ssh -X`):** once the relay below is running, relocalize from the
  laptop instead. The relay also forwards laptop `/initialpose_set_relayed_<robot_id>` to the
  robot's `/initialpose`, so in the laptop RViz (Step 5 below) add
  `-r /initialpose:=/initialpose_set_relayed_<robot_id>` and use "2D Pose Estimate" against
  `/ALIGNED_POINTS_relayed_<id>` over `/GRID_MAP_relayed_<id>`.

  **Without RViz:** from the Foxy devcontainer (domain 0, laptop profile exported),
  `python3 scripts/localize.py <robot_id>` scores how well the live cloud fits the map and
  searches ±1 m / ±20° for a better pose; `--apply` sends it, `--pose x y yaw` sets one by
  hand. The robot must be standing (its lidar is idle while asleep).

  **Relay setup that works (robot side):** `robot/fastdds_relay.xml` (set the robot's p2p0
  address) and `robot/start_relays.sh`, copied into the relay container as
  `/root/fastdds_relay.xml` and `/root/start_relays.sh`; then `ROBOT_ID=<id> /root/start_relays.sh`.
  The profile must pin the Wi-Fi address *and* all three internal `10.21.3x.103` addresses,
  with SHM enabled — see the comments in the file for what breaks otherwise. Never run
  anything ROS 2 Jazzy on domain 0: it crashes these Foxy relays.

- Step 4 : Run the relay node to convert DeepRobotics topics to ROS topics 

```bash
docker compose up -d nav_cmd_bridge
docker exec -it nav_cmd_bridge bash
export ROBOT_ID=<robot_id>
export ROS_DOMAIN_ID=0
ros2 launch nav_cmd_bridge relays.launch.py 
```
wait for atleast 2 mins for the above relay node to start, you should see a bunch of topics being published. 

`ROBOT_ID` suffixes every relayed topic and relay node name (`/ODOM_relayed_<robot_id>`, `odom_relay_<robot_id>`)
and prefixes every frame id except `map` (`<robot_id>/base_link`), so any number of robots can share one
`ROS_DOMAIN_ID`. All robots publish TF into the shared `/tf_relayed` and `/tf_static_relayed`, so they
must all run the same map. Left unset you get the original single-robot names.

# Laptop side setup

- Step 1 : Connect to the router WiFi "near-robots-5G" 
- Step 2 : Install devcontainer on vscode and open in devcontainer (ctrl + shift + p and select build in devcontainer)
- Step 3 : fix ros domain and fastdds profile (in every laptop terminal)
```bash
export ROS_DOMAIN_ID=0
export FASTRTPS_DEFAULT_PROFILES_FILE=fastdds_profile.xml
source install/setup.bash
```
- Step 4 : Verify if all topics appear 
```bash
ros2 topic list
ros2 topic hz /ODOM_relayed_<robot_id>
```
- Step 5 : Launch rviz on the robots' shared TF. Do not relay TF into `/tf`: the robots would relay it back in a loop.
```bash
rviz2 --ros-args -r /tf:=/tf_relayed -r /tf_static:=/tf_static_relayed -r /goal_pose:=/goal_pose_<robot_id>
```
Set Fixed Frame to `map`. Per robot id, enable /ALIGNED_POINTS_relayed_<id>, /ODOM_relayed_<id> and
/NAV_POINTS_relayed_<id>, plus one /GRID_MAP_relayed_<id>, and add a "2D Goal Pose" tool with topic /goal_pose_<id>.
- Step 6 : Before you run any nav commands, on the robot controller, standup the robot from controller
- Step 7 : In one terminal per robot, `export ROBOT_ID=<id>` and run any of the following nav bridge commands with that robot's `--ip`
(goals come from /goal_pose_<id>)

```bash
# Single waypoint
ros2 run nav_cmd_bridge nav_cmd_bridge nav <x> <y> [yaw_rad]

# Multiple waypoints in sequence
ros2 run nav_cmd_bridge nav_cmd_bridge patrol <x,y,yaw> <x,y,yaw> ...
#preprogrammed waypoints for demo through door
ros2 run nav_cmd_bridge nav_cmd_bridge patrol --ip <robot_ip> -3.20162,-3.81141,-0.0404694 -1.72499,-3.88239,0.0412739 0.200177,-1.78368,0.00477056

# RViz2 bridge — draw a 2D Goal Pose arrow to navigate immediately (USE THIS ONE)
ros2 run nav_cmd_bridge nav_cmd_bridge bridge --ip <robot_ip> 

# RViz2 bridge — queue mode: collect arrows, execute all on ENTER
ros2 run nav_cmd_bridge nav_cmd_bridge bridge queue --ip <robot_ip> 

# Robot emergency stop commands
ros2 run nav_cmd_bridge nav_cmd_bridge estop --ip <robot_ip> 
ros2 run nav_cmd_bridge nav_cmd_bridge cancel --ip <robot_ip> 
```
# Fleet orchestration with Open-RMF (branch `dev-openrmf`)

`rmf/` holds a ROS 2 Jazzy Open-RMF stack for the laptop: an M20 fleet adapter over the
same UDP API as above, mission primitives (patrol, form up, explore, inspect, ...), a YAML
mission runner and mock robots for rehearsal. Open the repo in the **"Open-RMF (ROS2
Jazzy)"** dev container and start with [`rmf/README.md`](rmf/README.md).
