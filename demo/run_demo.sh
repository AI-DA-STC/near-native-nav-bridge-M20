#!/usr/bin/env bash
# Suspicious-item search demo from the waypoints saved by demo/record_waypoints.sh (in WAYPOINTS). Start every
# robot's bridge first, and for the Aloha what aloha/run_aloha.sh needs. From the sweep on, demo/detect_box.py watches
# R3's camera (only R3's) for the box (R3 default 738); without video after 3 tries, the sweep ends and the cordon starts. Ctrl+C ends the demo: no more waypoints are sent, each robot
# still drives to the one it has, and the Aloha's arms stop where they are.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WAYPOINTS=${WAYPOINTS:-$HERE/waypoints}
INSTRUCTION="Execute a systematic sweep of Zone A to scan for unattended or anomalous items"
R3=${R3:-738}

fleet() {
    python3 "$HERE/../scripts/fleet_management.py" "$1" --load "$WAYPOINTS/$2.json" --ros-args -p show_box:=${3:-false} &
    pid=$!
}

stop() {
    kill "$pid" 2>/dev/null || true
    wait "$pid" || true
}

for phase in patrol formation sweep cordon; do
    if [[ ! -f $WAYPOINTS/$phase.json ]]; then
        echo "No $WAYPOINTS/$phase.json: record it with demo/record_waypoints.sh $phase" >&2
        exit 1
    fi
done
if [[ ! -f $WAYPOINTS/aloha.json ]]; then
    echo "No $WAYPOINTS/aloha.json: the Aloha's pose at the box, as {\"aloha\": [{\"x\": ..., \"y\": ..., \"yaw\": ...}]}" >&2
    exit 1
fi
if [[ ! -f $WAYPOINTS/manipulator.json ]]; then
    echo "No $WAYPOINTS/manipulator.json: teach the Aloha's arm poses at the box with aloha/teach_manipulator.sh" >&2
    exit 1
fi
trap 'exit 130' INT
trap 'kill $(jobs -p) 2>/dev/null || true; wait' EXIT

while true; do
    echo -e "\n=== Patrol: type the operator instruction and press ENTER at any time to break the loop ===\n"
    fleet multi-waypoint-patrol patrol
    read -r instruction
    stop
    echo -e "\n[DEMO] Operator: ${instruction:-$INSTRUCTION}"

    echo -e "\n=== Formation: every robot to its slot in the line ===\n"
    fleet single-waypoint formation
    echo "[DEMO] Generating a plan..."
    sleep 5
    cat <<'EOF'

Plan SR2-01: search zones 1–3 (about 5 min)
R1: Sweep zone 1 → cordon zone 3 → return to slot 1 → patrol
R2: Sweep zone 2 → cordon zone 3 → return to slot 2 → patrol
R3: Sweep zone 3 → report suss item → watch suss item → return to slot 3 → patrol
ALOHA: Standby → drive to box → open lid → scan contents → dock

EOF
    answer=
    until [[ $answer == approve || $answer == deny ]]; do
        read -r -p "Operator approval (approve/deny): " answer
        answer=${answer,,}
    done
    if [[ $answer == approve ]]; then
        break
    fi
    stop
    echo "[DEMO] Plan SR2-01 denied: back to patrolling"
done

echo "[DEMO] Plan SR2-01 approved, waiting for every robot to reach its slot"
wait "$pid"

echo -e "\n=== Sweep: every robot sweeps its zone ===\n"
python3 "$HERE/detect_box.py" --robot "$R3" --give-up 3 &  # until the demo ends, or 3 tries without video
detect=$!
fleet multi-waypoint sweep
while kill -0 "$pid" 2>/dev/null && kill -0 "$detect" 2>/dev/null; do
    sleep 1
done
if kill -0 "$pid" 2>/dev/null; then  # the detection gave up: the cordon now, each robot drives to the waypoint it has
    echo "[DEMO] No video from R3's camera: on to the cordon"
    stop
else
    wait "$pid"
fi
echo "[DEMO] R3: suspicious item reported next to the box, watching it"

echo -e "\n=== Cordon: R1 and R2 cordon off zone 3 ===\n"
fleet single-waypoint cordon true
wait "$pid"
echo "[DEMO] Zone 3 cordoned off"

echo -e "\n=== Aloha: drive to the box, dock and open the lid ===\n"
# On the Aloha's ROS_DOMAIN_ID (aloha/bridge.sh), only for this command: the fleet stays on its own. In the foreground,
# so that Ctrl+C also stops the arms
ROS_DOMAIN_ID=1 WAYPOINTS=$WAYPOINTS "$HERE/../aloha/run_aloha.sh"
echo "[DEMO] ALOHA done at the box"

echo -e "\n=== Verdict: the operator marks the box's contents ===\n"
verdict=
until [[ $verdict == anomaly || $verdict == clear ]]; do
    read -r -p "Operator verdict (anomaly/clear): " verdict
    verdict=${verdict,,}
done
echo "[DEMO] Operator verdict: ${verdict^^}"
if [[ $verdict == clear ]]; then
    echo -e "\n=== Return to formation: every robot back to its slot in the line ===\n"
    fleet single-waypoint formation true
    wait "$pid"
    echo "[DEMO] Every robot back in formation"
fi
