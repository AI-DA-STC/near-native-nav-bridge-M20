#!/usr/bin/env bash
# Suspicious-item search demo from the waypoints saved by demo/record_waypoints.sh (in WAYPOINTS). Start every
# robot's bridge first. Ctrl+C ends the demo: no more waypoints are sent, each robot still drives to the one it has.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WAYPOINTS=${WAYPOINTS:-$HERE/waypoints}
INSTRUCTION="Execute a systematic sweep of Zone A to scan for unattended or anomalous items"

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
fleet multi-waypoint sweep
wait "$pid"
echo "[DEMO] R3: suspicious item reported next to the box, watching it"

echo -e "\n=== Cordon: R1 and R2 cordon off zone 3 ===\n"
fleet single-waypoint cordon true
wait "$pid"
echo "[DEMO] Zone 3 cordoned off"
