import type { MissionSnapshot } from '@/shared/api'
import { ROBOT_KEYS, robotOf, type RobotKey } from '@/shared/config'
import { formatDuration, formatTimeOfDay, type Tone } from '@/shared/lib'
import { robotStateOf } from './robot-state'
import type { ImageView } from './suspicious-item'

/** A frame older than this is no longer live: the feed sends one a second */
export const CAMERA_STALE_MS = 3000

export interface CameraTileView {
  robot: RobotKey
  /** "R1 · 741" */
  name: string
  /** front camera, centre camera */
  camera: string
  /** The robot's state word over its feed (SWEEPING, IN SLOT, NOT CONNECTED …) and its tone */
  word: string
  tone: Tone
  state: 'live' | 'stale' | 'none'
  /** The latest frame, its URL changing with each new one; null before the first */
  src: string | null
  /** stale: "no frame for 12 s"; none: what to check */
  note: string | null
  /** The frame enlarged in the lightbox */
  image: ImageView | null
}

/** One tile per robot in the mission, in the fleet's order: the dogs' front cameras and the ALOHA's centre camera, each
 * with its robot's state word */
export function cameraTilesOf(snap: MissionSnapshot): CameraTileView[] {
  return ROBOT_KEYS.filter((k) => snap.robots[k].inMission).map((robot) => {
    const facts = snap.cameras?.[robot]
    const at = facts?.at ?? null
    const name = robot === 'aloha' ? 'ALOHA' : `${robotOf(robot).label} · ${snap.robots[robot].id}`
    const camera = robot === 'aloha' ? 'centre camera' : 'front camera'
    const state = at === null ? 'none' : snap.serverTime - at < CAMERA_STALE_MS ? 'live' : 'stale'
    const src = at === null ? null : `/api/mission/camera/${robot}.jpg?at=${at}`
    const hint = robot === 'aloha' ? 'is stream.launch running on the ALOHA?' : 'is its relay running?'
    const { word, tone } = robotStateOf(robot, snap)
    return {
      robot,
      name,
      camera,
      word,
      tone,
      state,
      src,
      note: state === 'none' ? `No video: ${hint}` : state === 'stale' ? `no frame for ${formatDuration(snap.serverTime - at!)}` : null,
      image:
        src && at !== null
          ? { src, boxes: [], aspect: '16 / 9', caption: `${name} · ${camera} · ${formatTimeOfDay(at)}`, meta: facts?.topic ?? '' }
          : null,
    }
  })
}

/** R3's camera, for the Suspicious item panel while it waits: whether its frames are arriving */
export function cameraLive(snap: MissionSnapshot, robot: RobotKey): boolean {
  const at = snap.cameras?.[robot]?.at ?? null
  return at !== null && snap.serverTime - at < CAMERA_STALE_MS
}
