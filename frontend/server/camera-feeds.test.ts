import { describe, expect, it } from 'vitest'
import { CameraFeeds } from './camera-feeds.ts'
import { frameLine } from './ros-checks.ts'

describe('camera feeds', () => {
  it('only the ALOHA’s two wrist cameras, through its bridge: the dogs’ cameras and its centre camera stay on the robots', () => {
    const feeds = new CameraFeeds('/nonexistent', () => undefined)
    expect(feeds.facts({ r1: '741', r3: '738', aloha: 'aloha' })).toEqual({
      'aloha-left': { topic: '/camera_l/color/image_throttled/compressed', at: null },
      'aloha-right': { topic: '/camera_r/color/image_throttled/compressed', at: null },
    })
    expect(feeds.facts({ r1: '741' })).toEqual({})
    expect(feeds.file('aloha-left')).toBeNull()
    expect(feeds.file('../etc/passwd')).toBeNull()
  })
  it('reads camera_frames.py’s lines', () => {
    expect(frameLine('frame r3 1795401116175')).toEqual({ key: 'r3', at: 1795401116175 })
    expect(frameLine('frame aloha 1795401116175\r')).toEqual({ key: 'aloha', at: 1795401116175 })
    expect(frameLine('[WARN] something else')).toBeNull()
  })
})
