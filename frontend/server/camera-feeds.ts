import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CameraFacts } from '../src/shared/api/mission-stream.ts'
import { ROBOT_CAMERAS, type RobotKey } from '../src/shared/config/fleet.ts'
import { watchCameraFrames } from './ros-checks.ts'

/* The robots' cameras for the Command center, at most one frame a second each: the ALOHA's two wrist cameras
 * (ROBOT_CAMERAS), throttled by aloha/robot/stream.launch, through aloha/bridge.sh on ROS_DOMAIN_ID 1. The dogs' cameras
 * and the ALOHA's centre camera stay on the robots: over the shared Wi-Fi, they flooded it. The latest frame of each
 * lies in a folder of the OS's temp dir, named after the camera's key. */

/** Which robots to watch: each role with its robot's ID */
export type CameraRoles = Partial<Record<RobotKey, string>>

/** aloha/bridge.sh's, where every camera in ROBOT_CAMERAS is */
const CAMERA_DOMAIN = 1

export class CameraFeeds {
  readonly dir = join(tmpdir(), 'command-center-frames')
  private readonly packageRoot: string
  private readonly onFrame: () => void
  /** Camera key -> its latest frame's time */
  private readonly frames = new Map<string, number>()
  private watcher: { topics: string; stop: () => void } | null = null

  constructor(packageRoot: string, onFrame: () => void) {
    this.packageRoot = packageRoot
    this.onFrame = onFrame
  }

  /** Watches the cameras of these robots, and only these */
  follow(roles: CameraRoles): void {
    const topics = Object.fromEntries(this.camerasOf(roles).map((c) => [c.key, c.topic]))
    const key = JSON.stringify(topics)
    if (this.watcher?.topics === key) return
    this.watcher?.stop()
    this.watcher = null
    this.frames.clear()
    if (!Object.keys(topics).length) return
    const stop = watchCameraFrames(CAMERA_DOMAIN, topics, this.dir, this.packageRoot, (k, at) => {
      this.frames.set(k, at)
      this.onFrame()
    })
    this.watcher = { topics: key, stop }
  }

  /** The cameras of these robots, by key: each one's topic and latest frame's time */
  facts(roles: CameraRoles): Record<string, CameraFacts> {
    return Object.fromEntries(this.camerasOf(roles).map((c) => [c.key, { topic: c.topic, at: this.frames.get(c.key) ?? null }]))
  }

  private camerasOf(roles: CameraRoles) {
    return ROBOT_CAMERAS.filter((c) => roles[c.robot] !== undefined)
  }

  /** The latest frame's file, for GET /api/mission/camera/<key>.jpg; null before the first */
  file(key: string): string | null {
    if (!ROBOT_CAMERAS.some((c) => c.key === key) || !this.frames.has(key)) return null
    const file = join(this.dir, `${key}.jpg`)
    return existsSync(file) ? file : null
  }

  stop(): void {
    this.watcher?.stop()
    this.watcher = null
  }
}
