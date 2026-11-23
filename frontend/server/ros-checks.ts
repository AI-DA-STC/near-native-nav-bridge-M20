import { spawn, type ChildProcess } from 'node:child_process'
import type { PoseFact } from '../src/shared/api/setup-protocol.ts'
import { echoedMessages, echoedPose, hzRates, publisherCount, subscriptionCount, topicsListed } from './command-output.ts'

/* Checks the setup makes on this workstation without typing them into a terminal: they decide what the setup does next
 * or what it shows, and are not README steps. They run with the README's laptop environment (Laptop side, Step 3), from
 * the package root, like the laptop terminal. */

const LAPTOP_ENV = [
  'source /opt/ros/foxy/setup.bash',
  'export ROS_DOMAIN_ID=0',
  'export FASTRTPS_DEFAULT_PROFILES_FILE=fastdds_profile.xml',
  'source install/setup.bash',
].join(' && ')

function startHidden(script: string, packageRoot: string): ChildProcess {
  return spawn('bash', ['-c', `${LAPTOP_ENV} && ${script}`], {
    cwd: packageRoot,
    // ros2 is Python: unbuffered, or a pipe holds its output back
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    // Its own process group, so stopping it stops ros2 too
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function stop(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return
  try {
    process.kill(-child.pid, 'SIGINT')
  } catch {
    // already gone
  }
}

/** Everything a short command prints, stopped after `timeoutMs` */
function runHidden(script: string, packageRoot: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = startHidden(script, packageRoot)
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()))
    const timer = setTimeout(() => stop(child), timeoutMs)
    child.on('close', () => {
      clearTimeout(timer)
      resolve(output)
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(output)
    })
  })
}

/** How many publish /ODOM_relayed_<id> already: 1 or more means a relay runs for this robot. null: could not tell. */
export async function odomPublishers(id: string, packageRoot: string): Promise<number | null> {
  return publisherCount(await runHidden(`ros2 topic info /ODOM_relayed_${id}`, packageRoot, 15_000))
}

/** How many listen on /goal_pose_<id>: 1 or more means a nav bridge runs for this robot. null: could not tell. */
export async function goalListeners(id: string, packageRoot: string): Promise<number | null> {
  return subscriptionCount(await runHidden(`ros2 topic info /goal_pose_${id}`, packageRoot, 15_000))
}

/** Reports every 2D Pose Estimate sent to the robot while it runs; returns the stop */
export function watchInitialPose(id: string, packageRoot: string, onPose: (pose: PoseFact) => void): () => void {
  const child = startHidden(`ros2 topic echo /initialpose_relayed_${id}`, packageRoot)
  let rest = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    const read = echoedMessages(rest + chunk.toString())
    rest = read.rest.slice(-16_384)
    for (const message of read.messages) {
      const pose = echoedPose(message)
      if (pose) onPose({ ...pose, at: Date.now() })
    }
  })
  child.stderr?.resume()
  child.on('error', () => undefined)
  return () => stop(child)
}

/** Where the robot is, from its relayed odometry (the pose fleet_management.py --record saves): every message, metres and
 * degrees; returns the stop */
export function watchOdom(id: string, packageRoot: string, onPose: (pose: PoseFact) => void): () => void {
  return watchPose(`ros2 topic echo --no-arr /ODOM_relayed_${id}`, packageRoot, onPose)
}

/** Where the ALOHA is, from its AMCL pose on aloha/bridge.sh's ROS_DOMAIN_ID=1 (what record_waypoints.sh aloha saves).
 * The bridge latches it and AMCL only publishes when it updates: the echo asks for the last one, and names the type
 * since the topic may not be discovered yet. Returns the stop. */
export function watchAmclPose(packageRoot: string, onPose: (pose: PoseFact) => void): () => void {
  return watchPose(
    'export ROS_DOMAIN_ID=1 && ros2 topic echo --qos-durability transient_local --qos-reliability reliable --no-arr /amcl_pose geometry_msgs/msg/PoseWithCovarianceStamped',
    packageRoot,
    onPose,
  )
}

/** The last pose of each batch an echo prints */
function watchPose(script: string, packageRoot: string, onPose: (pose: PoseFact) => void): () => void {
  const child = startHidden(script, packageRoot)
  let rest = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    const read = echoedMessages(rest + chunk.toString())
    rest = read.rest.slice(-16_384)
    const last = read.messages.at(-1)
    const pose = last ? echoedPose(last) : null
    if (pose) onPose({ ...pose, at: Date.now() })
  })
  child.stderr?.resume()
  child.on('error', () => undefined)
  return () => stop(child)
}

/** The topics on another ROS_DOMAIN_ID (the ALOHA's bridge is on 1), found without the ros2 daemon */
export async function domainTopics(domain: number, packageRoot: string): Promise<string[]> {
  return topicsListed(await runHidden(`export ROS_DOMAIN_ID=${domain} && ros2 topic list --no-daemon --spin-time 3`, packageRoot, 15_000))
}

/** A topic's rate on a ROS_DOMAIN_ID, from `ros2 topic hz` for up to `forMs`: null when nothing arrived */
export async function topicRate(domain: number, topic: string, packageRoot: string, forMs = 8000): Promise<number | null> {
  const output = await runHidden(`export ROS_DOMAIN_ID=${domain} && ros2 topic hz ${topic}`, packageRoot, forMs)
  return hzRates(output).at(-1) ?? null
}

/** The dogs' SLAM map from `topic` (/GRID_MAP_relayed_<id>), written as a PNG to `out` by map_grid.py; where it lies in
 * the map frame, or null when none came */
export async function readGrid(topic: string, out: string, packageRoot: string): Promise<{ x: number; y: number; w: number; h: number; yaw: number } | null> {
  const output = await runHidden(`python3 frontend/server/map_grid.py ${topic} ${out}`, packageRoot, 25_000)
  const line = output.split('\n').find((l) => l.startsWith('{'))
  if (!line) return null
  try {
    const grid = JSON.parse(line) as { x: number; y: number; w: number; h: number; yaw: number }
    return [grid.x, grid.y, grid.w, grid.h, grid.yaw].every(Number.isFinite) ? grid : null
  } catch {
    return null
  }
}
