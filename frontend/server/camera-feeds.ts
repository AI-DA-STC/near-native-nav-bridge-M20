import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CameraFacts } from '../src/shared/api/mission-stream.ts'
import { ROBOT_KEYS, type RobotKey } from '../src/shared/config/fleet.ts'
import { watchCameraFrames } from './ros-checks.ts'

/* The robots' cameras for the Command center, at most one frame a second each: every dog's front camera, as
 * scripts/camera_relay.py publishes it on the dog (ROS_DOMAIN_ID 0), and the ALOHA's centre camera (camera_f of its
 * multi_camera.launch, throttled by aloha/robot/stream.launch, through aloha/bridge.sh on ROS_DOMAIN_ID 1). The latest
 * frame of each lies in a folder of the OS's temp dir, named after the robot's role. */

/** The topic each robot's frames come from: a dog's by its ID */
export function cameraTopic(key: RobotKey, id: string): string {
  return key === 'aloha' ? '/camera_f/color/image_throttled/compressed' : `/camera_front_relayed_${id}`
}

/** Which robots to watch: each role with its robot's ID */
export type CameraRoles = Partial<Record<RobotKey, string>>

export class CameraFeeds {
  readonly dir = join(tmpdir(), 'command-center-frames')
  private readonly packageRoot: string
  private readonly onFrame: () => void
  private readonly frames = new Map<RobotKey, number>()
  /** One watcher per ROS_DOMAIN_ID, with the topics it watches */
  private readonly watchers = new Map<number, { topics: string; stop: () => void }>()

  constructor(packageRoot: string, onFrame: () => void) {
    this.packageRoot = packageRoot
    this.onFrame = onFrame
  }

  /** Watches the cameras of these robots, and only these */
  follow(roles: CameraRoles): void {
    for (const domain of [0, 1]) {
      const topics = Object.fromEntries(
        ROBOT_KEYS.filter((k) => roles[k] !== undefined && (k === 'aloha') === (domain === 1)).map((k) => [k, cameraTopic(k, roles[k]!)]),
      )
      const key = JSON.stringify(topics)
      const current = this.watchers.get(domain)
      if (current?.topics === key) continue
      current?.stop()
      this.watchers.delete(domain)
      // A role that now has another robot, or none, starts again without a frame
      for (const k of ROBOT_KEYS) if ((k === 'aloha') === (domain === 1)) this.frames.delete(k)
      if (!Object.keys(topics).length) continue
      const stop = watchCameraFrames(domain, topics, this.dir, this.packageRoot, (k, at) => {
        this.frames.set(k as RobotKey, at)
        this.onFrame()
      })
      this.watchers.set(domain, { topics: key, stop })
    }
  }

  /** Each robot's camera: its topic and its latest frame's time */
  facts(roles: CameraRoles): Partial<Record<RobotKey, CameraFacts>> {
    return Object.fromEntries(
      ROBOT_KEYS.filter((k) => roles[k] !== undefined).map((k) => [k, { topic: cameraTopic(k, roles[k]!), at: this.frames.get(k) ?? null }]),
    )
  }

  /** The latest frame's file, for GET /api/mission/camera/<role>.jpg; null before the first */
  file(key: string): string | null {
    if (!(ROBOT_KEYS as readonly string[]).includes(key) || !this.frames.has(key as RobotKey)) return null
    const file = join(this.dir, `${key}.jpg`)
    return existsSync(file) ? file : null
  }

  stop(): void {
    for (const w of this.watchers.values()) w.stop()
    this.watchers.clear()
  }
}
