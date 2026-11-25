import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { servableImage } from './mission-hub.ts'

/* The images /api/mission/image serves: what the scripts wrote (demo/detections) and what is kept with the demo
 * (demo/assets), nothing else */

const ROOT = '/ws'

describe('servableImage', () => {
  it('serves the photos the scripts wrote, by relative or absolute path', () => {
    expect(servableImage(ROOT, 'demo/detections/contents_20261124_070336.jpg')).toBe(join(ROOT, 'demo/detections/contents_20261124_070336.jpg'))
    expect(servableImage(ROOT, '/ws/demo/detections/contents_20261124_070334_left_annotated.jpg')).toBe('/ws/demo/detections/contents_20261124_070334_left_annotated.jpg')
  })

  it('serves find_box.py’s photo of the box from demo/assets', () => {
    expect(servableImage(ROOT, '/ws/demo/assets/unattended_item.jpg')).toBe('/ws/demo/assets/unattended_item.jpg')
    expect(servableImage(ROOT, 'demo/assets/unattended_item.png')).toBe(join(ROOT, 'demo/assets/unattended_item.png'))
  })

  it('serves nothing else: other folders, a way out, other files, or the folder itself', () => {
    expect(servableImage(ROOT, 'demo/waypoints/current/map.png')).toBeNull()
    expect(servableImage(ROOT, 'demo/assets/../../frontend/server/maps/grid.png')).toBeNull()
    expect(servableImage(ROOT, '/etc/hosts.png')).toBeNull()
    expect(servableImage(ROOT, 'demo/assets/box.json')).toBeNull()
    expect(servableImage(ROOT, '/ws/demo/assets-old/unattended_item.jpg')).toBeNull()
    expect(servableImage(ROOT, '/ws/demo/assets.jpg')).toBeNull()
  })
})
