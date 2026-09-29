#!/usr/bin/env bash
# Start / stop the whole M20 Open-RMF stack in one tmux window, from the host.
#
#   scripts/m20_stack.sh up        start devcontainers if needed, open the tmux session
#   scripts/m20_stack.sh relay     only start the robots' relays (own tmux session);
#                                  `up` then leaves them alone
#   scripts/m20_stack.sh attach    re-attach to it
#   scripts/m20_stack.sh status    containers, panes, robots
#   scripts/m20_stack.sh dashboard build the operator dashboard (web devcontainer; needs
#                                  internet the first time), served by the ui pane
#   scripts/m20_stack.sh netcheck  Wi-Fi load, each robot's relay traffic, ping, internet
#                                  (run while the relays are up; needs nothing else)
#   scripts/m20_stack.sh restart <pane>   Ctrl-C one pane and start it again, e.g.
#                                  `restart rmf` after `m20 place/lane/route` edits
#   scripts/m20_stack.sh down      Ctrl-C every pane (clean shutdown), then close it
#
#   M20_RELAY=none|odom|full overrides robot_relay; M20_NO_ATTACH=1 starts detached.
#
# Panes (all settings from m20_stack.yaml, nothing to export):
#   relay <id>  ssh into each robot, start its relay in the robot's container; stays in
#               ssh showing the relay's output, reconnects if the link drops
#   bridge      Foxy devcontainer: laptop_bridge.launch.py (domain 0 -> 20)
#   rmf         Jazzy devcontainer: m20_rmf.launch.py (Open-RMF + M20 adapter)
#   events      Jazzy devcontainer: m20 events (every command sent, live)
#   ui          Jazzy devcontainer: the operator dashboard http://localhost:8080 (Open-RMF's
#               dashboard + our mission panels) and its hub; RViz (M20_RVIZ=false: none)
#   rmf-api     Open-RMF's rmf-web API server (docker image), which the dashboard's
#               map / robots / tasks panels read
#   mission     Jazzy devcontainer: m20 mission-host, runs the missions the GUI starts.
#               Ctrl-C here aborts the mission and stops its robots (standing) - the
#               fallback when the GUI is not usable
#   operator    Jazzy devcontainer: shell for m20 status / go / mission / stop
#
# This script never moves a robot; motion is only started from the GUI or the operator
# pane. Stop: STOP in the GUI, Ctrl-C in the mission pane, `m20 stop` (none drop it).
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
    'ROBOT_PROFILE': str(c.get('robot_profile', '/root/m20_relay_profile.xml')),
    'ROBOT_COMPOSE_DIR': str(c.get('robot_compose_dir', '~')),
    'ROBOT_COMPOSE_SERVICE': str(c.get('robot_compose_service', 'nav_cmd_bridge')),
    'ROBOTS_DOMAIN': str(c.get('robots_domain', 0)),
    'RMF_DOMAIN': str(c.get('rmf_domain', 20)),
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
  local rid=$1 ip var="IP_$1" inner stale
  ip=${!var}
  [ -n "$ip" ] || { echo "echo 'robot $rid has no ip in the site file'"; return; }
  # Odometry goes best effort: over Wi-Fi a lost pose is replaced by the next one, and
  # reliable delivery (resending every lost fragment, for three robots) swamped the
  # laptop's link on 2026-09-29. The SLAM map is large and republished often: relayed
  # only on request (odom+map), e.g. for m20 map-save; the GUI draws the site's map file.
  local odom="ros2 run nav_cmd_bridge odom_relay --ros-args -r __node:=odom_relay_$rid -p input_topic:=/ODOM -p output_topic:=/ODOM_relayed_$rid -p frame_prefix:=\"'$rid'\" -p reliability:=best_effort -p depth:=5"
  local grid="ros2 run nav_cmd_bridge occupancygrid_relay --ros-args -r __node:=grid_map_relay_$rid -p input_topic:=/GRID_MAP -p output_topic:=/GRID_MAP_relayed_$rid -p frame_prefix:=\"'$rid'\""
  case "$RELAY_MODE" in
    odom) # odometry only: all RMF and the GUI need
          stale="[_]_node:=(odom|grid_map)_relay_$rid"
          inner="$odom" ;;
    odom+map) # + the SLAM map (for m20 map-save, or a site without a map file)
          stale="[_]_node:=(odom|grid_map)_relay_$rid"
          inner="trap 'kill 0' EXIT; $grid & $odom & wait" ;;
    full) stale="[r]elays.launch.py"; inner="ros2 launch nav_cmd_bridge relays.launch.py" ;;
    none) echo "echo 'robot_relay: none -> start the relay on $rid yourself'"; return ;;
    *) die "robot_relay must be odom, odom+map, full or none" ;;
  esac
  inner="source /opt/ros/foxy/setup.bash && source /root/ros2_ws/install/setup.bash && export ROBOT_ID=$rid ROS_DOMAIN_ID=$ROBOTS_DOMAIN FASTRTPS_DEFAULT_PROFILES_FILE=$ROBOT_PROFILE && $inner"
  # Robots are powered off daily: the relay container may be stopped, or gone. On the
  # robot: recreate it from its compose file if missing, start it, and install the relay
  # DDS profile: ours, at a path of our own (robot_profile), refreshed on every start. The
  # team's own ~/fastdds_relay.xml (mounted read-only into the container on some robots,
  # and lacking the 10.21.31.103 localizer address) is left alone.
  local remote="set -e
if ! docker info >/dev/null 2>&1; then
  echo \"\$(whoami) cannot use docker on robot $rid ($ip). Once, on the robot:\"
  echo \"  sudo usermod -aG docker \$(whoami)    (then this pane reconnects by itself)\"
  exit 1
fi
C=$ROBOT_CONTAINER
if ! docker inspect \$C >/dev/null 2>&1; then
  echo \"relay container \$C missing: recreating ($ROBOT_COMPOSE_SERVICE in $ROBOT_COMPOSE_DIR)\"
  cd $ROBOT_COMPOSE_DIR && docker compose up -d $ROBOT_COMPOSE_SERVICE
fi
docker start \$C >/dev/null
docker cp /tmp/m20_relay_profile.xml \$C:$ROBOT_PROFILE
# A dropped connection leaves the previous relay running inside the container (docker
# exec does not hang up its process): end it, or the robot would publish twice.
if docker exec \$C pkill -f '$stale'; then echo 'ended a relay left from a dropped connection'; sleep 1; fi
exec docker exec -it \$C bash -c \"\$(echo $(b64 "$inner") | base64 -d)\""
  local ssh="ssh -o ServerAliveInterval=5 -o ServerAliveCountMax=6 -o ConnectTimeout=10" scp="scp -q -o ConnectTimeout=10"
  if [ -n "$SSH_KEY" ] && [ -f "$SSH_KEY" ]; then
    ssh="$ssh -i $SSH_KEY -o IdentitiesOnly=yes"; scp="$scp -i $SSH_KEY -o IdentitiesOnly=yes"
  fi
  local prof="/tmp/m20_relay_profile_$rid.xml"
  # The pane stays in ssh with the relay's output. If the relay ends by itself or the
  # link drops (Wi-Fi, robot reboot), it reconnects; Ctrl-C (-t: it reaches the relay on
  # the robot) stops it for good. 130 = ended by Ctrl-C, 255 = ssh could not connect.
  local loop="trap 'quit=1' INT
quit=
echo '== relay on $rid ($ip, $RELAY_MODE). Ctrl-C stops it.'
sed 's/192\\.168\\.123\\.102/$ip/g' $REPO/robot/fastdds_relay.xml > $prof
while :; do
  if $scp $prof $SSH_USER@$ip:/tmp/m20_relay_profile.xml; then
    $ssh -t $SSH_USER@$ip \"bash -c \\\"\\\$(echo $(b64 "$remote") | base64 -d)\\\"\"
    code=\$?
  else
    code=255
  fi
  [ -n \"\$quit\" ] && break
  [ \$code = 130 ] && { echo '== relay on $rid stopped (Ctrl-C)'; break; }
  why=''; [ \$code = 255 ] && why=': robot unreachable or connection lost'
  echo \"== relay on $rid ended (exit \$code\$why) at \$(date +%T). Reconnecting in 5 s, Ctrl-C to stop.\"
  sleep 5
  [ -n \"\$quit\" ] && { echo '== relay on $rid: not reconnecting'; break; }
done"
  echo "bash -c \"\$(echo $(b64 "$loop") | base64 -d)\""
}

foxy_cmd() {
  in_container "$FOXY" 'source /opt/ros/foxy/setup.bash && cd /root/ros2_ws && { colcon build --packages-select nav_cmd_bridge > /tmp/m20_build.log 2>&1 || { tail -20 /tmp/m20_build.log; exit 1; }; } && source install/setup.bash && ros2 launch nav_cmd_bridge laptop_bridge.launch.py'
}

rmf_cmd() {   # the monitor also forwards RMF's updates to the rmf-web API server (rmf-api)
  in_container "$JAZZY" 'bash /repo/rmf/build.sh > /tmp/m20_build.log 2>&1 || tail -20 /tmp/m20_build.log; source /ws/install/setup.bash; ros2 launch m20_rmf m20_rmf.launch.py forward:=ws://localhost:8000/_internal'
}

RMF_API_IMAGE=ghcr.io/open-rmf/rmf-web/api-server:jazzy-nightly

rmf_api_cmd() {   # Open-RMF's rmf-web API server (:8000), read by the dashboard
  # A Jazzy node on the RMF domain: it gets our Jazzy DDS profile, like every Jazzy
  # process here, so it cannot upset the Foxy bridge (see rmf/fastdds_jazzy.xml). Task
  # history lives in the docker volume m20-rmf-web.
  echo "trap 'docker stop -t 3 m20-rmf-api >/dev/null 2>&1' EXIT; docker rm -f m20-rmf-api >/dev/null 2>&1; \
docker run --rm --name m20-rmf-api --network host -e ROS_DOMAIN_ID=$RMF_DOMAIN \
  -e RMW_IMPLEMENTATION=rmw_fastrtps_cpp -e FASTRTPS_DEFAULT_PROFILES_FILE=/m20/fastdds_jazzy.xml \
  -v $REPO/rmf/fastdds_jazzy.xml:/m20/fastdds_jazzy.xml:ro -v m20-rmf-web:/ws/run $RMF_API_IMAGE"
}

WEB_CFG="$REPO/.devcontainer/web/devcontainer.json"
DASHBOARD="$REPO/rmf/m20_rmf/dashboard"

dashboard() {   # build the operator dashboard into rmf/m20_rmf/dashboard/dist
  local w
  w=$(ensure_container "$WEB_CFG" web)
  docker exec -w /repo/rmf/m20_rmf/dashboard "$w" ./build.sh
}

events_cmd() {
  in_container "$JAZZY" 'sleep 8; m20 events'
}

ui_cmd() {       # demo console (hub + web GUI on :8080) + RViz markers + RViz
  in_container "$JAZZY" "sleep 10; ros2 launch m20_rmf demo.launch.py rviz:=${M20_RVIZ:-true}"
}

mission_cmd() {   # runs the missions started from the GUI; Ctrl-C = abort + stop
  in_container "$JAZZY" 'sleep 8; m20 mission-host'
}

operator_cmd() {
  in_container "$JAZZY" 'cd /repo; clear; echo "operator shell  |  m20 status  |  m20 go <robot> <place>  |  m20 mission <file>  |  m20 stop [robot]  (no drop)"; echo "Ctrl-C on a moving command stops that robot. GUI missions: Ctrl-C in the mission pane."; echo "In /repo (the repo root): paths like rmf/m20_rmf/sites/x.yaml work as in m20_stack.yaml."; exec bash -i'
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
  [ -f "$DASHBOARD/dist/index.html" ] || echo "NOTE: the operator dashboard is not built: scripts/m20_stack.sh dashboard (needs internet once); :8080 shows the older console meanwhile"
  docker image inspect "$RMF_API_IMAGE" >/dev/null 2>&1 || echo "NOTE: no $RMF_API_IMAGE: docker pull it (needs internet), or the dashboard's map/robots/tasks stay empty"

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
  pane mission "$(mission_cmd)"
  pane rmf-api "$(rmf_api_cmd)"
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

restart() {   # $1 = pane title: rmf | ui | bridge | events | mission | operator | "relay <id>"
  local name="$*" pane cmd
  [ -n "$name" ] || die "restart which pane? rmf | ui | bridge | events | mission | operator | 'relay <id>'"
  tmux has-session -t "=$SESSION" 2>/dev/null || die "stack not running (scripts/m20_stack.sh up)"
  read_stack
  FOXY=$(container_for "$FOXY_CFG"); JAZZY=$(container_for "$JAZZY_CFG")
  pane=$(tmux list-panes -t "=$SESSION:" -F '#{pane_id}	#{@m20_title}' | awk -F'\t' -v n="$name" '$2 == n {print $1}')
  [ -n "$pane" ] || die "no pane '$name' (panes: $(tmux list-panes -t "=$SESSION:" -F '#{@m20_title}' | paste -sd, -))"
  case "$name" in
    rmf) cmd=$(rmf_cmd) ;;
    ui) cmd=$(ui_cmd) ;;
    bridge) cmd=$(foxy_cmd) ;;
    events) cmd=$(events_cmd) ;;
    mission) cmd=$(mission_cmd) ;;
    rmf-api) cmd=$(rmf_api_cmd) ;;
    operator) cmd=$(operator_cmd) ;;
    "relay "*) cmd=$(relay_cmd "${name#relay }") ;;
    *) die "cannot restart '$name'" ;;
  esac
  # Ctrl-C first so the processes in the container end cleanly (killing the pane
  # would leave them running), then start the same command again in that pane.
  # The pane's own process is a bash running the command; when the command has ended it
  # is a plain shell with no children left.
  local ppid; ppid=$(tmux display -p -t "$pane" '#{pane_pid}')
  tmux send-keys -t "$pane" C-c
  for _ in $(seq 20); do
    pgrep -P "$ppid" >/dev/null || break
    sleep 1
  done
  pgrep -P "$ppid" >/dev/null && echo "'$name' did not end on Ctrl-C within 20 s: killing its pane" >&2
  tmux respawn-pane -k -t "$pane" "$cmd; echo; echo '[$name ended - shell]'; exec bash"
  echo "restarted $name"
}

netcheck() {   # how loaded the robots' Wi-Fi is, and by what
  read_stack
  local j dev secs=10 t0 rx0 tx0 rx1 tx1 out
  j=$(container_for "$JAZZY_CFG")
  dev=$(ip route get 192.168.123.1 2>/dev/null | grep -o 'dev [^ ]*' | cut -d' ' -f2)
  [ -n "$dev" ] || die "no route to the robots' network (192.168.123.0/24)"
  out=$(mktemp -d)
  # per-robot relay traffic, measured on the laptop side (adds nothing to the Wi-Fi)
  if [ -n "$j" ]; then
    for rid in $ROBOTS; do
      for t in ODOM_relayed GRID_MAP_relayed; do
        docker exec "$j" bash -c "source /ws/install/setup.bash; export ROS_DOMAIN_ID=$RMF_DOMAIN
          timeout $((secs - 1)) ros2 topic hz /${t}_$rid 2>/dev/null | grep 'average rate' | tail -1
          " > "$out/hz_${t}_$rid" 2>&1 &
        docker exec "$j" bash -c "source /ws/install/setup.bash; export ROS_DOMAIN_ID=$RMF_DOMAIN
          timeout $((secs - 1)) ros2 topic bw /${t}_$rid 2>/dev/null | grep -E 'B/s from' | tail -1
          " > "$out/bw_${t}_$rid" 2>&1 &
      done
    done
  fi
  for rid in $ROBOTS; do
    local var="IP_$rid"; ping -c 8 -i 0.5 -W 1 "${!var}" 2>/dev/null | tail -2 > "$out/ping_$rid" &
  done
  ( curl -s -o /dev/null -m 8 -w '%{time_total}' https://api.anthropic.com > "$out/net" 2>/dev/null || echo fail > "$out/net" ) &
  rx0=$(cat /sys/class/net/$dev/statistics/rx_bytes); tx0=$(cat /sys/class/net/$dev/statistics/tx_bytes); t0=$(date +%s.%N)
  wait
  rx1=$(cat /sys/class/net/$dev/statistics/rx_bytes); tx1=$(cat /sys/class/net/$dev/statistics/tx_bytes)
  local dt; dt=$(echo "$(date +%s.%N) - $t0" | bc)
  echo "Wi-Fi ($dev, $(iw dev "$dev" link 2>/dev/null | awk -F': ' '/SSID/{print $2}')):" \
    "receive $(echo "($rx1 - $rx0) / $dt / 1024" | bc) KB/s, send $(echo "($tx1 - $tx0) / $dt / 1024" | bc) KB/s"
  for rid in $ROBOTS; do
    echo "robot $rid:"
    for t in ODOM_relayed GRID_MAP_relayed; do
      local hz bw
      hz=$(sed 's/average rate: /rate /' "$out/hz_${t}_$rid" 2>/dev/null | head -1)
      bw=$(head -1 "$out/bw_${t}_$rid" 2>/dev/null)
      printf '  %-18s %s\n' "$t" "${hz:-no data}${bw:+ | $bw}"
    done
    echo "  ping: $(grep -o '[0-9]*% packet loss' "$out/ping_$rid"), $(grep -o 'rtt.*' "$out/ping_$rid" | cut -d= -f2)"
  done
  echo "internet (api.anthropic.com): $(cat "$out/net") s"
  rm -rf "$out"
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
  restart) shift; restart "$@" ;;
  netcheck) netcheck ;;
  dashboard) dashboard ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 1 ;;
esac
