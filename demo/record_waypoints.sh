#!/usr/bin/env bash
# Records the search demo's waypoints by driving each robot with its remote: ENTER in fleet_management saves the
# robot's current pose. Usage: demo/record_waypoints.sh [patrol] [formation] [sweep] [cordon]  (default: all four)
# Robot ids: R1, R2, R3 (default 741 665 738) and PATROL_ROBOTS (default all three); files go to WAYPOINTS
# (default demo/waypoints). ONLY="<ids>" records just those robots and keeps the others' waypoints in the file.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WAYPOINTS=${WAYPOINTS:-$HERE/waypoints}
R1=${R1:-741} R2=${R2:-665} R3=${R3:-738}
PATROL_ROBOTS=${PATROL_ROBOTS:-"$R1 $R2 $R3"}

record() {
    local phase=$1 mode=$2 what=$3 robots=()
    shift 3
    for rid; do
        if [[ -z ${ONLY:-} || " $ONLY " == *" $rid "* ]]; then robots+=("$rid"); fi
    done
    if [[ ${#robots[@]} -eq 0 ]]; then
        echo -e "\n=== $phase: none of ONLY=$ONLY takes part, skipped ==="
        return
    fi
    echo -e "\n=== $phase ($mode, R1=$R1 R2=$R2 R3=$R3): $what ===\n"
    python3 "$HERE/../scripts/fleet_management.py" "$mode" "${robots[@]}" --record "$WAYPOINTS/$phase.json" \
        --ros-args -p show_box:=true
}

trap 'exit 130' INT
mkdir -p "$WAYPOINTS"
[[ $# -gt 0 ]] || set -- patrol formation sweep cordon
for phase; do
    case $phase in
        patrol)    record patrol multi-waypoint-patrol \
                       "each robot's perimeter, ENTER at every corner in order (3 or more, not the first one again)" \
                       $PATROL_ROBOTS ;;
        formation) record formation single-waypoint \
                       "R1, R2, R3 to slots 1, 2, 3 of the horizontal line, ENTER once per robot" "$R1" "$R2" "$R3" ;;
        sweep)     record sweep multi-waypoint \
                       "each robot's sweep of zone 1, 2, 3 in order, ENTER at every waypoint; R3 ends next to the box" \
                       "$R1" "$R2" "$R3" ;;
        cordon)    record cordon single-waypoint \
                       "R1 and R2 to their cordon points around zone 3, ENTER once per robot" "$R1" "$R2" ;;
        *)         echo "Unknown phase '$phase': patrol, formation, sweep or cordon" >&2; exit 1 ;;
    esac
done
