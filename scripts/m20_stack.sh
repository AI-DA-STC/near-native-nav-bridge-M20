#!/usr/bin/env bash
# Start / stop the whole M20 Open-RMF stack in one tmux window, from the host.
#
#   scripts/m20_stack.sh up        start devcontainers if needed, open the tmux session
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
#   operator    Jazzy devcontainer: shell for m20 status / go / mission / stop
#
# This script never moves a robot; motion is only ever typed in the operator pane.
# Stop a robot with `m20 stop <id>` (no drop) or Ctrl-C on the command that moves it.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION=m20
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
    odom) inner="ros2 run nav_cmd_bridge odom_relay --ros-args -r __node:=odom_relay_$rid -p input_topic:=/ODOM -p output_topic:=/ODOM_relayed_$rid -p frame_prefix:=\"'$rid'\"" ;;
    full) inner="ros2 launch nav_cmd_bridge relays.launch.py" ;;
    none) echo "echo 'robot_relay: none -> start the relay on $rid yourself'"; return ;;
    *) die "robot_relay must be odom, full or none" ;;
  esac
  inner="source /opt/ros/foxy/setup.bash && source /root/ros2_ws/install/setup.bash && export ROBOT_ID=$rid ROS_DOMAIN_ID=$ROBOTS_DOMAIN FASTRTPS_DEFAULT_PROFILES_FILE=$ROBOT_PROFILE && $inner"
  local ssh="ssh -t -o ServerAliveInterval=5 -o ConnectTimeout=20"
  [ -n "$SSH_KEY" ] && [ -f "$SSH_KEY" ] && ssh="$ssh -i $SSH_KEY -o IdentitiesOnly=yes"
  # -t on ssh and docker exec so Ctrl-C in the pane reaches the relay on the robot.
  echo "echo '== relay on $rid ($ip, $RELAY_MODE); Ctrl-C to stop'; $ssh $SSH_USER@$ip 'docker exec -it $ROBOT_CONTAINER bash -c \"\$(echo $(b64 "$inner") | base64 -d)\"'; echo '== relay on $rid ended'"
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

operator_cmd() {
  in_container "$JAZZY" 'clear; echo "operator shell  |  m20 status  |  m20 go <robot> <place>  |  m20 mission <file>  |  m20 stop [robot]  (no drop)"; echo "Ctrl-C on a moving command stops that robot."; exec bash -i'
}

# --- actions ----------------------------------------------------------------------
up() {
  command -v tmux >/dev/null || die "tmux not installed (sudo apt install tmux)"
  tmux has-session -t $SESSION 2>/dev/null && { echo "already up; attaching"; exec tmux attach -t $SESSION; }
  read_stack
  FOXY=$(ensure_container "$FOXY_CFG" Foxy)
  JAZZY=$(ensure_container "$JAZZY_CFG" Jazzy)
  echo "robots: $ROBOTS  relay: $RELAY_MODE  site: $SITE"

  # Each pane runs its command directly (no send-keys); when a command ends the pane
  # drops to a shell so its output stays readable.
  pane() {   # $1 = title, $2 = command
    local cmd="$2; echo; echo '[$1 ended - shell]'; exec bash"
    if [ -z "${FIRST_PANE_USED:-}" ]; then
      tmux new-session -d -s $SESSION -n stack -x 240 -y 60 "$cmd"
      FIRST_PANE_USED=1
      tmux set -t $SESSION pane-border-status top >/dev/null
      # Titles from a pane option: shells overwrite the plain pane title with their prompt.
      tmux set -t $SESSION pane-border-format ' #{@m20_title} ' >/dev/null
      tmux set -t $SESSION mouse on >/dev/null
      LAST_PANE=$(tmux list-panes -t $SESSION -F '#{pane_id}' | head -1)
    else
      LAST_PANE=$(tmux split-window -t "$LAST_PANE" -P -F '#{pane_id}' "$cmd")
      tmux select-layout -t "$LAST_PANE" tiled >/dev/null
    fi
    tmux set -p -t "$LAST_PANE" @m20_title "$1" >/dev/null
  }
  for rid in $ROBOTS; do pane "relay $rid" "$(relay_cmd "$rid")"; done
  pane bridge "$(foxy_cmd)"
  pane rmf "$(rmf_cmd)"
  pane events "$(events_cmd)"
  pane operator "$(operator_cmd)"
  tmux select-layout -t "$LAST_PANE" tiled >/dev/null
  echo "attach: scripts/m20_stack.sh attach   detach: Ctrl-b d   stop all: scripts/m20_stack.sh down"
  [ -n "${M20_NO_ATTACH:-}" ] || exec tmux attach -t $SESSION
}

down() {
  tmux has-session -t $SESSION 2>/dev/null || { echo "not running"; return; }
  echo "sending Ctrl-C to every pane..."
  for p in $(tmux list-panes -t $SESSION -F '#{pane_id}'); do tmux send-keys -t "$p" C-c; done
  sleep 6
  for p in $(tmux list-panes -t $SESSION -F '#{pane_id}'); do tmux send-keys -t "$p" C-c; done
  sleep 2
  tmux kill-session -t $SESSION
  echo "stopped. (Robots keep standing; any goal they had is cancelled only by m20 stop / Ctrl-C of the command.)"
}

status() {
  read_stack
  echo "containers: foxy=$(container_for "$FOXY_CFG" || true) jazzy=$(container_for "$JAZZY_CFG" || true)"
  if tmux has-session -t $SESSION 2>/dev/null; then
    tmux list-panes -t $SESSION -F '  #{@m20_title}: #{pane_current_command}'
  else
    echo "  tmux session: not running"
  fi
  local j; j=$(container_for "$JAZZY_CFG")
  [ -n "$j" ] && docker exec "$j" bash -ic 'm20 status 2>/dev/null' 2>/dev/null | sed -n '1,10p' || true
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  attach) exec tmux attach -t $SESSION ;;
  status) status ;;
  *) sed -n '2,20p' "$0"; exit 1 ;;
esac
