#!/bin/bash
# Bridge the Aloha's navigation, Piper arm and camera topics (bridge.yaml) to ROS_DOMAIN_ID=1. The camera images need
# robot/stream.launch running on the robot; arm_status and end_pose_euler need build_bridge.sh to have been run.
ROBOT_IP=${ROBOT_IP:-192.168.123.200}
ALOHA_BRIDGE=${ALOHA_BRIDGE:-/opt/aloha_bridge}
export ROS_DOMAIN_ID=1
trap 'kill $(jobs -p) 2>/dev/null; wait' EXIT

# Decompress the throttled JPEGs back to /camera_X/color/image_raw, with ROS 2 alone: noetic's libclass_loader
# shadows foxy's
source /opt/ros/foxy/setup.bash
for cam in camera_f camera_l camera_r; do
    ros2 run image_transport republish compressed raw --ros-args -r __node:=decompress_$cam \
        -r in/compressed:=/$cam/color/image_throttled/compressed -r out:=/$cam/color/image_raw &
done

source /opt/ros/noetic/setup.bash
[[ -f $ALOHA_BRIDGE/ros1/setup.bash ]] && source "$ALOHA_BRIDGE/ros1/setup.bash" --extend
source /opt/ros/foxy/setup.bash
if [[ -f $ALOHA_BRIDGE/bridge/setup.bash ]]; then
    source "$ALOHA_BRIDGE/bridge/setup.bash"
else
    echo "[ALOHA] No $ALOHA_BRIDGE: bridging without piper_msgs (run aloha/build_bridge.sh to add them)" >&2
fi
export ROS_MASTER_URI=http://$ROBOT_IP:11311
export ROS_IP=$(python3 -c "import socket; s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(('$ROBOT_IP', 1)); print(s.getsockname()[0])")
rosparam load "$(dirname "$0")/bridge.yaml"

# The robot has to connect back here, for what it starts after this bridge (the cameras' stream.launch) and for all that
# goes to it (arm commands, navigation goals). Check by having its master call back a server here, as it calls the bridge
python3 - <<'EOF'
import os, threading, xmlrpc.client, xmlrpc.server

called = threading.Event()

def publisherUpdate(caller_id, topic, publishers):
    called.set()
    return [1, "", 0]

server = xmlrpc.server.SimpleXMLRPCServer(("0.0.0.0", 0), logRequests=False)
server.register_function(publisherUpdate)
threading.Thread(target=server.serve_forever, daemon=True).start()
uri = f"http://{os.environ['ROS_IP']}:{server.server_address[1]}/"
name = f"/aloha_bridge_check_{os.getpid()}"
master = xmlrpc.client.ServerProxy(os.environ["ROS_MASTER_URI"])
try:
    master.registerSubscriber(name, name + "/topic", "std_msgs/Empty", uri)
    master.registerPublisher(name + "_pub", name + "/topic", "std_msgs/Empty", uri)
    ok = called.wait(3)
    master.unregisterSubscriber(name, name + "/topic", uri)
    master.unregisterPublisher(name + "_pub", name + "/topic", uri)
except OSError as e:
    print(f"[ALOHA] Could not check that the robot reaches this laptop: {e}")
else:
    if not ok:
        print(f"\n[ALOHA] WARNING: the robot cannot connect back to this laptop ({os.environ['ROS_IP']}), most likely "
              "because of this laptop's firewall. The cameras (anything the robot starts after this bridge), the arm "
              "commands and the navigation goals will not get through. Let the robot in, e.g. sudo ufw allow from "
              f"{os.environ['ROS_MASTER_URI'].split('//')[1].split(':')[0]} on this laptop (not in the container), "
              "then restart bridge.sh\n")
EOF

ros2 run ros1_bridge parameter_bridge
