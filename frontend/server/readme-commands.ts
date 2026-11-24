import type { RobotKind, RoutePhase } from '../src/shared/api/setup-protocol.ts'

/* Every command the setup types, verbatim from the package's README.md (the ALOHA's from its own start_aloha.sh) with
 * their placeholders filled in, so the GUI does exactly what you would do by hand. readme-commands.test.ts fails if one
 * no longer appears there. */

/** This workstation's plain-HTTP registry, as the README names it */
export const REGISTRY = '192.168.123.160:5000'

/** "Docker pull instructions in robot", "Robot side setup" and "Laptop side setup" */
export const README = {
  // Robot side, Step 2: `ssh user@<robot_ip>`, user being the M20's login (the ALOHA's is agilex)
  ssh: (ip: string, user = 'user') => `ssh ${user}@${ip}`,
  // Robot side, Step 3 (first line)
  su: 'su',
  // Docker pull instructions in robot
  pull: 'docker pull --platform linux/arm64 192.168.123.160:5000/m20-bridge:foxy',
  tag: 'docker tag  192.168.123.160:5000/m20-bridge:foxy m20-bridge:foxy',
  // Robot side, Step 3
  composeUp: 'docker compose up -d nav_cmd_bridge',
  composeExec: 'docker compose exec nav_cmd_bridge bash',
  exportRobotId: (id: string) => `export ROBOT_ID=${id}`,
  exportDomain: 'export ROS_DOMAIN_ID=0',
  launchRelays: 'ros2 launch nav_cmd_bridge relays.launch.py',
  // Laptop side, Step 3 (export ROS_DOMAIN_ID=0 as above)
  exportProfile: 'export FASTRTPS_DEFAULT_PROFILES_FILE=fastdds_profile.xml',
  sourceInstall: 'source install/setup.bash',
  // Laptop side, Step 4
  topicList: 'ros2 topic list',
  topicHz: (id: string) => `ros2 topic hz /ODOM_relayed_${id}`,
  // Laptop side, Step 5
  rviz: (id: string) => `rviz2 --ros-args -r /goal_pose:=/goal_pose_${id} -r /initialpose:=/initialpose_relayed_${id}`,
  // Multi-robot, Step 1 (with ROBOT_ID exported): the plain bridge fleet_management.py's goals go through. It only sends
  // the robot a heartbeat until a goal arrives on /goal_pose_<id>
  navBridge: (ip: string) => `ros2 run nav_cmd_bridge nav_cmd_bridge bridge --ip ${ip}`,
  // Multi-robot, Step 2: the 2D Goal Pose tool on /fleet_goal, where no bridge listens (recording takes it as a waypoint)
  rvizFleet: 'rviz2 --ros-args -r /goal_pose:=/fleet_goal',
  // Recording demo waypoints, the table's aloha row: the ALOHA's RViz, on aloha/bridge.sh's domain
  rvizAloha: 'ROS_DOMAIN_ID=1 rviz2 --ros-args -r /goal_pose:=/fleet_goal',
  // "On robot, trust the laptop's plain-HTTP registry": shown to the operator, never typed
  daemonJson: '{ "insecure-registries": ["192.168.123.160:5000"] }',
  restartDocker: 'sudo systemctl restart docker',
} as const

/** README laptop side, Step 5, with -d: RViz opens on this robot's map, odometry and waypoints (rviz-config.ts) instead
 * of the displays saved last in ~/.rviz2/default.rviz. Everything after -d <config> is the README's line. */
export function rvizWithConfig(id: string, config: string): string {
  return README.rviz(id).replace(/^rviz2 /, `rviz2 -d ${config} `)
}

/** The RViz a recording draws in, with -d: the dogs' (README Multi-robot Step 2) or the ALOHA's (the recording table's
 * aloha row), on the config routes-rviz.ts writes. Everything but -d <config> is the README's line. */
export function routesRvizCommand(which: 'dogs' | 'aloha', config: string): string {
  return (which === 'dogs' ? README.rvizFleet : README.rvizAloha).replace(/rviz2 /, `rviz2 -d ${config} `)
}

/** The Mobile ALOHA: aloha/robot/start_aloha.sh in the robot's home (its usage lines), and aloha/bridge.sh here */
export const ALOHA = {
  start: 'bash start_aloha.sh',
  stop: 'bash start_aloha.sh stop',
  bridge: 'aloha/bridge.sh',
  /** tmux's prefix (Ctrl+b), then d: detaches from start_aloha.sh's session and leaves it running */
  detach: '\x02d',
} as const

/** Not in the README: typed only when the operator picks them, or (daemonStop) when the topic list looks stale */
export const RECOVERY = {
  restartContainer: 'docker compose restart nav_cmd_bridge',
  daemonStop: 'ros2 daemon stop',
  removeHostKey: (ip: string) => `ssh-keygen -R ${ip}`,
} as const

/** The logins as written down: every M20 is user with the password ' (README: "password = ' (single quote)"), the
 * ALOHA agilex with agx (start_aloha.sh's PASSWORD). The lobby's form starts from these. */
export const DEFAULT_LOGIN: Readonly<Record<RobotKind, { user: string; password: string }>> = {
  m20: { user: 'user', password: "'" },
  aloha: { user: 'agilex', password: 'agx' },
}

/** Every node relays.launch.py starts: one per entry of its RELAYS. An image built before the relays were cut down to
 * these starts 8 (the lidar, TF and camera too) */
export const RELAY_NODE_COUNT = 4

/** The topics relays.launch.py makes for a robot, suffixed with its ID: the odometry and map it publishes, and the two
 * poses it takes from the laptop */
export function relayedTopics(id: string): string[] {
  return ['ODOM', 'GRID_MAP', 'initialpose', 'goal_pose'].map((name) => `/${name}_relayed_${id}`)
}

/** relays.launch.py uses the ID raw in topic and node names ("Must be alphanumeric/underscore"), and the setup types it
 * into shells */
export const ROBOT_ID_PATTERN = /^[A-Za-z0-9_]+$/

/** A login name, as ssh takes it: typed into a shell, so nothing else */
export const USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/

/** README "Recording demo waypoints", Step 3, for one robot (`ONLY="665" demo/record_waypoints.sh patrol`), into the
 * plan folder `waypoints` (the script's WAYPOINTS) */
export function recordWaypoints(phase: RoutePhase, robot: string, waypoints: string, append: boolean): string {
  return `ONLY="${robot}" ${append ? 'APPEND=1 ' : ''}WAYPOINTS=${waypoints} demo/record_waypoints.sh ${phase}`
}
