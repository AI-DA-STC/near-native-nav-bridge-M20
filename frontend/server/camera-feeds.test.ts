import { describe, expect, it } from 'vitest'
import { cameraTopic } from './camera-feeds.ts'
import { frameLine } from './ros-checks.ts'

describe('camera feeds', () => {
  it('a dog’s front camera by its ID, the ALOHA’s centre camera through its bridge', () => {
    expect(cameraTopic('r1', '741')).toBe('/camera_front_relayed_741')
    expect(cameraTopic('aloha', 'aloha')).toBe('/camera_f/color/image_throttled/compressed')
  })
  it('reads camera_frames.py’s lines', () => {
    expect(frameLine('frame r3 1795401116175')).toEqual({ key: 'r3', at: 1795401116175 })
    expect(frameLine('frame aloha 1795401116175\r')).toEqual({ key: 'aloha', at: 1795401116175 })
    expect(frameLine('[WARN] something else')).toBeNull()
  })
})
