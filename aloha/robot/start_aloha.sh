#!/bin/bash
# Start everything the Aloha runs in a tmux session, one window each: roscore, the cameras, the Piper arms, the lidar,
# the base, navigation, stream.launch and dock.py (copy it next to this script). Works over SSH, and keeps running if
# SSH drops.
#   bash start_aloha.sh       start them all and attach
#   tmux attach -t aloha      attach again, after detaching or losing SSH
#   bash start_aloha.sh stop  Ctrl+C them all, then close the session
# In tmux: Ctrl+b then n / p (or a click on the bottom bar) switches window, Ctrl+b then d detaches, the mouse wheel
# scrolls (hold Shift to select text). Ctrl+C stops a window's command; Up then Enter starts it again.
PASSWORD=agx  # sudo, for the CAN setups
PIPER_ARGS="mode:=1 auto_enable:=true"  # "mode:=0 auto_enable:=false" to teach with aloha/teach_manipulator.sh
MAP=/home/agilex/agilex_ws/src/ranger_ros/ranger_bringup/maps/aloha_map_aligned.yaml

command -v tmux >/dev/null || { echo "Needs tmux: sudo apt install tmux" >&2; exit 1; }

if [[ $1 == stop ]]; then
    for w in $(tmux list-windows -t aloha -F '#{window_name}' 2>/dev/null | grep -vx roscore); do
        tmux send-keys -t "aloha:$w" C-c
    done
    for _ in $(seq 30); do  # until every window is back at its shell; roscore goes last
        busy=$(tmux list-windows -t aloha -F '#{window_name} #{pane_current_command}' 2>/dev/null |
               grep -v '^roscore ' | grep -cvE ' (ba)?sh$')
        [[ $busy == 0 ]] && break
        sleep 1
    done
    tmux send-keys -t aloha:roscore C-c 2>/dev/null && sleep 2
    tmux kill-session -t aloha 2>/dev/null
    exit 0
fi

if tmux has-session -t aloha 2>/dev/null; then
    echo "Already running: tmux attach -t aloha, or bash start_aloha.sh stop" >&2
    exit 1
fi
source /opt/ros/noetic/setup.bash
if rosnode list >/dev/null 2>&1; then
    echo "A ROS master is already running: stop the old launches first" >&2
    exit 1
fi

window() {  # name, command: typed into the window's shell, as by hand
    tmux new-window -d -t aloha -n "$1"
    tmux send-keys -t "aloha:$1" "$2" Enter
}

tmux new-session -d -s aloha -n roscore
tmux set-option -t aloha mouse on >/dev/null
tmux send-keys -t aloha:roscore roscore Enter
for _ in $(seq 30); do
    rosnode list >/dev/null 2>&1 && break
    sleep 1
done
rosnode list >/dev/null 2>&1 || { echo "roscore did not start: see tmux attach -t aloha" >&2; exit 1; }

window cameras "roslaunch realsense2_camera multi_camera.launch"
window arms "cd ~/cobot_magic/Piper_ros_private-ros-noetic; source devel/setup.bash; echo $PASSWORD | sudo -S -p '' -v; \
yes Y | bash can_muti_activate.sh; roslaunch piper start_ms_piper.launch $PIPER_ARGS"
window lidar "roslaunch ranger_bringup open_lidar.launch"
window base "echo $PASSWORD | sudo -S -p '' -v; rosrun ranger_bringup setup_can2usb.bash; \
roslaunch ranger_bringup ranger_mini_v2.launch"
window navigation "sleep 10; roslaunch ranger_bringup navigation_4wd.launch map_file:=$MAP"  # once the lidar and base are up
window stream "roslaunch ~/stream.launch"
window dock "python3 ~/dock.py"  # precise docking, for send_goal.py --dock

if [[ -n $TMUX ]]; then
    tmux switch-client -t aloha
elif [[ -t 0 && -t 1 ]]; then
    exec tmux attach -t aloha
else
    echo "Started: tmux attach -t aloha"
fi
