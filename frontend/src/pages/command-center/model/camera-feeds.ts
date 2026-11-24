import type { MissionSnapshot } from '@/shared/api'
import { ROBOT_CAMERAS, type RobotKey } from '@/shared/config'
import { formatDuration, formatTimeOfDay, type Tone } from '@/shared/lib'
import { robotStateOf } from './robot-state'
import type { ImageView } from './suspicious-item'

/** A frame older than this is no longer live: the feed sends one a second */
export const CAMERA_STALE_MS = 3000

export interface CameraTileView {
  /** The camera's key (ROBOT_CAMERAS): "aloha-left" */
  key: string
  robot: RobotKey
  /** "ALOHA" */
  name: string
  /** "left wrist camera" */
  camera: string
  /** The robot's state word over its feed (SWEEPING, ARMS 4/5 · PHOTOS …) and its tone */
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

/** One tile per camera of the robots in the mission (ROBOT_CAMERAS: the ALOHA's two wrist cameras; the dogs' cameras
 * and the ALOHA's centre camera stay on the robots), each with its robot's state word */
export function cameraTilesOf(snap: MissionSnapshot): CameraTileView[] {
  return ROBOT_CAMERAS.filter((c) => snap.robots[c.robot].inMission).map(({ key, robot, label }) => {
    const facts = snap.cameras?.[key]
    const at = facts?.at ?? null
    const name = 'ALOHA'
    const camera = `${label} camera`
    const state = at === null ? 'none' : snap.serverTime - at < CAMERA_STALE_MS ? 'live' : 'stale'
    const src = at === null ? null : `/api/mission/camera/${key}.jpg?at=${at}`
    const { word, tone } = robotStateOf(robot, snap)
    return {
      key,
      robot,
      name,
      camera,
      word,
      tone,
      state,
      src,
      note: state === 'none' ? 'No video: is stream.launch running on the ALOHA?' : state === 'stale' ? `no frame for ${formatDuration(snap.serverTime - at!)}` : null,
      image:
        src && at !== null
          ? { src, boxes: [], aspect: '4 / 3', caption: `${name} · ${camera} · ${formatTimeOfDay(at)}`, meta: facts?.topic ?? '' }
          : null,
    }
  })
}
