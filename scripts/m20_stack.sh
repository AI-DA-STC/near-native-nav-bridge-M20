#!/usr/bin/env bash
# Start / stop the whole M20 Open-RMF stack in one tmux window, from the host.
#
#   scripts/m20_stack.sh up        start devcontainers if needed, open the tmux session
#   scripts/m20_stack.sh relay     only start the robots' relays (own tmux session);
#                                  `up` then leaves them alone
#   scripts/m20_stack.sh attach    re-attach to it
#   scripts/m20_stack.sh status    containers, panes, robots
#   scripts/m20_stack.sh down      Ctrl-C every pane (clean shutdown), then close it
#
#   M20_RELAY=none|odom|full overrides robot_relay; M20_NO_ATTACH=1 starts detached.
#
# Panes (all settings from m20_stack.yaml, nothing to export):
#   relay <id>  ssh into each robot, start its relay in the robot's container
#   bridge      Foxy devcontainer: laptop_bridge.launch.py (domain 0 -> 20)
#   rmf         Jazzy devcontainer: m20_rmf.launch.py (Open-RMF + M20 adapter)
#   events      Jazzy devcontainer: m20 events (every command sent, live)
#   ui          Jazzy devcontainer: demo GUI (http://localhost:8080) + RViz (M20_RVIZ=false: none)
#   operator    Jazzy devcontainer: shell for m20 status / go / mission / stop
#
# This script never moves a robot; motion is only ever typed in the operator pane.
# Stop a robot with `m20 stop <id>` (no drop) or Ctrl-C on the command that moves it.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION=m20
RELAY_SESSION=m20-relays
STACK="${M20_STACK:-$REPO/m20_stack.yaml}"
FOXY_CFG="$REPO/.devcontainer/devcontainer.json"
JAZZY_CFG="$REPO/.devcontainer/rmf-jazzy/devcontainer.json"

die() { echo "m20_stack: $*" >&2; exit 1; }

# --- settings from m20_stack.yaml (+ robot IPs from its site file) ---------------
read_stack() {
  [ -f "$STACK" ] || die "no $STACK"
  eval "$(python3 - "$STACK" <<'PY'
import os, shlex, sys, yaml
path = sys.argv[1]
base = os.path.dirname(os.path.abspath(path))
c = yaml.safe_load(open(path)) or {}
site = c.get('site', '')
site = site if os.path.isabs(site) else os.path.join(base, site)
robots = [str(r) for r in c.get('robots') or []]
ips = {}
if os.path.exists(site):
    s = yaml.safe_load(open(site)) or {}
    ips = {str(k): (v or {}).get('ip', '') for k, v in (s.get('robots') or {}).items()}
out = {
    'ROBOTS': ' '.join(robots),
    'RELAY_MODE': str(c.get('robot_relay', 'odom')),
    'SSH_USER': str(c.get('ssh_user', 'user')),
    'SSH_KEY': os.path.expanduser(str(c.get('ssh_key', ''))),
    'ROBOT_CONTAINER': str(c.get('robot_container', 'user-nav_cmd_bridge-1')),
    'ROBOT_PROFILE': str(c.get('robot_profile', '/root/fastdds_relay.xml')),
    'ROBOT_COMPOSE_DIR': str(c.get('robot_compose_dir', '~')),
    'ROBOT_COMPOSE_SERVICE': str(c.get('robot_compose_service', 'nav_cmd_bridge')),
    'ROBOTS_DOMAIN': str(c.get('robots_domain', 0)),
    'SITE': site,
}
for rid in robots:
    out[f'IP_{rid}'] = ips.get(rid, '')
for k, v in out.items():
    print(f'{k}={shlex.quote(v)}')
PY
)"
  [ -n "$ROBOTS" ] || die "no robots: in $STACK"
  RELAY_MODE="${M20_RELAY:-$RELAY_MODE}"   # env override, e.g. M20_RELAY=none
}

# --- devcontainers ----------------------------------------------------------------
container_for() {   # $1 = devcontainer.json path -> running container id (or empty)
  docker ps -q --filter "label=devcontainer.config_file=$1" | head -1
}

devcontainer_cli() {
  local ext js code
  ext=$(ls -d "$HOME"/.vscode/extensions/ms-vscode-remote.remote-containers-* 2>/dev/null | sort -V | tail -1)
  js="$ext/dist/spec-node/devContainersSpecCLI.js"
  for code in /snap/code/current/usr/share/code/code /usr/share/code/code; do
    [ -x "$code" ] && [ -f "$js" ] && { ELECTRON_RUN_AS_NODE=1 "$code" "$js" "$@"; return; }
  done
  command -v devcontainer >/dev/null && { devcontainer "$@"; return; }
  die "no devcontainer CLI: open the repo in VS Code and 'Reopen in Container' once"
}

ensure_container() {   # $1 = config, $2 = label for messages -> echoes container id
  local id
  id=$(container_for "$1")
  if [ -z "$id" ]; then
    echo "starting the $2 devcontainer (first time can take minutes)..." >&2
    devcontainer_cli up --workspace-folder "$REPO" --config "$1" >/dev/null
    id=$(container_for "$1")
    [ -n "$id" ] || die "could not start the $2 devcontainer"
  fi
  echo "$id"
}

# --- pane commands ----------------------------------------------------------------
# Inner commands are base64-encoded so no quoting survives the tmux -> shell -> ssh ->
# docker exec -> bash layers; the innermost shell decodes and runs them.
b64() { printf '%s' "$1" | base64 -w0; }

in_container() {   # $1 = container id, $2 = command (interactive bash env of that container)
  echo "docker exec -it $1 bash -ic \"\$(echo $(b64 "$2") | base64 -d)\""
}

relay_cmd() {   # $1 = robot id
  local rid=$1 ip var="IP_$1" inner
  ip=${!var}
  [ -n "$ip" ] || { echo "echo 'robot $rid has no ip in the site file'"; return; }
  case "$RELAY_MODE" in
    odom) # odometry (all RMF needs) + the SLAM map (latched: sent once, light on Wi-Fi)
          inner="trap 'kill 0' EXIT; ros2 run nav_cmd_bridge occupancygrid_relay --ros-args -r __node:=grid_map_relay_$rid -p input_topic:=/GRID_MAP -p output_topic:=/GRID_MAP_relayed_$rid -p frame_prefix:=\"'$rid'\" & ros2 run nav_cmd_bridge odom_relay --ros-args -r __node:=odom_relay_$rid -p input_topic:=/ODOM -p output_topic:=/ODOM_relayed_$rid -p frame_prefix:=\"'$rid'\" & wait" ;;
    full) inner="ros2 launch nav_cmd_bridge relays.launch.py" ;;
    none) echo "echo 'robot_relay: none -> start the relay on $rid yourself'"; return ;;
    *) die "robot_relay must be odom, full or none" ;;
  esac
  inner="source /opt/ros/foxy/setup.bash && source /root/ros2_ws/install/setup.bash && export ROBOT_ID=$rid ROS_DOMAIN_ID=$ROBOTS_DOMAIN FASTRTPS_DEFAULT_PROFILES_FILE=$ROBOT_PROFILE && $inner"
  # Robots are powered off daily: the relay container may be stopped, or gone. On the
  # robot: recreate it from its compose file if missing, start it, and install the relay
  # DDS profile only if the container has none (an existing profile is never replaced).
  local remote="set -e
C=$ROBOT_CONTAINER
if ! docker inspect \$C >/dev/null 2>&1; then
  echo \"relay container \$C missing: recreating ($ROBOT_COMPOSE_SERVICE in $ROBOT_COMPOSE_DIR)\"
  cd $ROBOT_COMPOSE_DIR && docker compose up -d $ROBOT_COMPOSE_SERVICE
fi
docker start \$C >/dev/null
if ! docker exec \$C test -f $ROBOT_PROFILE; then
  echo \"no relay profile in \$C: installing the repo's robot/fastdds_relay.xml for $ip\"
  docker cp /tmp/m20_relay_profile.xml \$C:$ROBOT_PROFILE
fi
exec docker exec -it \$C bash -c \"\$(echo $(b64 "$inner") | base64 -d)\""
  local ssh="ssh -o ServerAliveInterval=5 -o ConnectTimeout=20" scp="scp -q -o ConnectTimeout=20"
  if [ -n "$SSH_KEY" ] && [ -f "$SSH_KEY" ]; then
    ssh="$ssh -i $SSH_KEY -o IdentitiesOnly=yes"; scp="$scp -i $SSH_KEY -o IdentitiesOnly=yes"
  fi
  local prof="/tmp/m20_relay_profile_$rid.xml"
  # -t so Ctrl-C in the pane reaches the relay on the robot.
  echo "echo '== relay on $rid ($ip, $RELAY_MODE); Ctrl-C to stop'; sed 's/192\\.168\\.123\\.102/$ip/g' $REPO/robot/fastdds_relay.xml > $prof && $scp $prof $SSH_USER@$ip:/tmp/m20_relay_profile.xml; $ssh -t $SSH_USER@$ip \"bash -c \\\"\\\$(echo $(b64 "$remote") | base64 -d)\\\"\"; echo '== relay on $rid ended'"
}

foxy_cmd() {
  in_container "$FOXY" 'source /opt/ros/foxy/setup.bash && cd /root/ros2_ws && { colcon build --packages-select nav_cmd_bridge > /tmp/m20_build.log 2>&1 || { tail -20 /tmp/m20_build.log; exit 1; }; } && source install/setup.bash && ros2 launch nav_cmd_bridge laptop_bridge.launch.py'
}

rmf_cmd() {
  in_container "$JAZZY" 'bash /repo/rmf/build.sh > /tmp/m20_build.log 2>&1 || tail -20 /tmp/m20_build.log; source /ws/install/setup.bash; ros2 launch m20_rmf m20_rmf.launch.py'
}

events_cmd() {
  in_container "$JAZZY" 'sleep 8; m20 events'
}

ui_cmd() {       # demo console (hub + web GUI on :8080) + RViz markers + RViz
  in_container "$JAZZY" "sleep 10; ros2 launch m20_rmf demo.launch.py rviz:=${M20_RVIZ:-true}"
}

operator_cmd() {
  in_container "$JAZZY" 'clear; echo "operator shell  |  m20 status  |  m20 go <robot> <place>  |  m20 mission <file>  |  m20 stop [robot]  (no drop)"; echo "Ctrl-C on a moving command stops that robot."; exec bash -i'
}

# --- actions ----------------------------------------------------------------------
# Each pane runs its command directly (no send-keys); when a command ends the pane
# drops to a shell so its output stays readable.
pane() {   # $1 = title, $2 = command   (session: $PANE_SESSION)
  local cmd="$2; echo; echo '[$1 ended - shell]'; exec bash"
  if [ -z "${FIRST_PANE_USED:-}" ]; then
    tmux new-session -d -s $PANE_SESSION -n stack -x 240 -y 60 "$cmd"
    FIRST_PANE_USED=1
    tmux set -t "=$PANE_SESSION:" pane-border-status top >/dev/null
    # Titles from a pane option: shells overwrite the plain pane title with their prompt.
    tmux set -t "=$PANE_SESSION:" pane-border-format ' #{@m20_title} ' >/dev/null
    tmux set -t "=$PANE_SESSION:" mouse on >/dev/null
    LAST_PANE=$(tmux list-panes -t "=$PANE_SESSION:" -F '#{pane_id}' | head -1)
  else
    LAST_PANE=$(tmux split-window -t "$LAST_PANE" -P -F '#{pane_id}' "$cmd")
    tmux select-layout -t "$LAST_PANE" tiled >/dev/null
  fi
  tmux set -p -t "$LAST_PANE" @m20_title "$1" >/dev/null
}

up() {
  command -v tmux >/dev/null || die "tmux not installed (sudo apt install tmux)"
  tmux has-session -t "=$SESSION" 2>/dev/null && { echo "already up; attaching"; exec tmux attach -t "=$SESSION"; }
  read_stack
  # Containers run as root: allow them on this X display for RViz. The devcontainer
  # does this only when it is created, and the grant is lost on logout/reboot.
  xhost +SI:localuser:root >/dev/null 2>&1 || true
  FOXY=$(ensure_container "$FOXY_CFG" Foxy)
  JAZZY=$(ensure_container "$JAZZY_CFG" Jazzy)
  echo "robots: $ROBOTS  relay: $RELAY_MODE  site: $SITE"

  PANE_SESSION=$SESSION
  if tmux has-session -t "=$RELAY_SESSION" 2>/dev/null; then
    pane "relays" "echo 'relays run in the $RELAY_SESSION session (scripts/m20_stack.sh relay)'"
  else
    for rid in $ROBOTS; do pane "relay $rid" "$(relay_cmd "$rid")"; done
  fi
  pane bridge "$(foxy_cmd)"
  pane rmf "$(rmf_cmd)"
  pane events "$(events_cmd)"
  pane ui "$(ui_cmd)"
  pane operator "$(operator_cmd)"
  tmux select-layout -t "$LAST_PANE" tiled >/dev/null
  echo "attach: scripts/m20_stack.sh attach   detach: Ctrl-b d   stop all: scripts/m20_stack.sh down"
  [ -n "${M20_NO_ATTACH:-}" ] || exec tmux attach -t "=$SESSION"
}

relay() {
  command -v tmux >/dev/null || die "tmux not installed (sudo apt install tmux)"
  tmux has-session -t "=$RELAY_SESSION" 2>/dev/null && { echo "relays already up; attaching"; exec tmux attach -t "=$RELAY_SESSION"; }
  read_stack
  [ "$RELAY_MODE" != none ] || RELAY_MODE=odom
  PANE_SESSION=$RELAY_SESSION
  for rid in $ROBOTS; do pane "relay $rid" "$(relay_cmd "$rid")"; done
  tmux select-layout -t "$LAST_PANE" tiled >/dev/null
  echo "relays starting on: $ROBOTS ($RELAY_MODE). Ctrl-C in a pane stops that relay; scripts/m20_stack.sh down stops all."
  [ -n "${M20_NO_ATTACH:-}" ] || exec tmux attach -t "=$RELAY_SESSION"
}

down() {
  if tmux has-session -t "=$RELAY_SESSION" 2>/dev/null; then
    for p in $(tmux list-panes -t "=$RELAY_SESSION:" -F '#{pane_id}'); do tmux send-keys -t "$p" C-c; done
    sleep 3; tmux kill-session -t "=$RELAY_SESSION"; echo "relays stopped"
  fi
  tmux has-session -t "=$SESSION" 2>/dev/null || { echo "stack not running"; return; }
  echo "sending Ctrl-C to every pane..."
  for p in $(tmux list-panes -t "=$SESSION:" -F '#{pane_id}'); do tmux send-keys -t "$p" C-c; done
  sleep 6
  for p in $(tmux list-panes -t "=$SESSION:" -F '#{pane_id}'); do tmux send-keys -t "$p" C-c; done
  sleep 2
  tmux kill-session -t "=$SESSION"
  echo "stopped. (Robots keep standing; any goal they had is cancelled only by m20 stop / Ctrl-C of the command.)"
}

status() {
  read_stack
  echo "containers: foxy=$(container_for "$FOXY_CFG" || true) jazzy=$(container_for "$JAZZY_CFG" || true)"
  if tmux has-session -t "=$SESSION" 2>/dev/null; then
    tmux list-panes -t "=$SESSION:" -F '  #{@m20_title}: #{pane_current_command}'
  else
    echo "  tmux session: not running"
  fi
  local j; j=$(container_for "$JAZZY_CFG")
  [ -n "$j" ] && docker exec "$j" bash -ic 'm20 status 2>/dev/null' 2>/dev/null | sed -n '1,10p' || true
}

case "${1:-}" in
  up) up ;;
  relay) relay ;;
  down) down ;;
  attach) exec tmux attach -t "=$SESSION" ;;
  status) status ;;
  *) sed -n '2,20p' "$0"; exit 1 ;;
esac
