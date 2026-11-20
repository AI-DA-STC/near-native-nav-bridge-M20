import { describe, expect, it } from 'vitest'
import { robotRviz, rvizConfigPath } from './rviz-config.ts'

/* Each robot's RViz shows its own topics: the template with ROBOT_ID replaced */

describe('a robot’s RViz config', () => {
  const config = robotRviz('741')
  const topics = [...config.matchAll(/^\s+Value: (\/\S+)$/gm)].map((m) => m[1])

  it('has the robot’s map, odometry, waypoints and point cloud, and no other robot’s', () => {
    expect(topics).toEqual([
      '/GRID_MAP_relayed_741',
      '/GRID_MAP_relayed_741_updates',
      '/ODOM_relayed_741',
      '/waypoint_markers_741',
      '/ALIGNED_POINTS_relayed_741',
      '/initialpose',
      '/goal_pose',
      '/clicked_point',
    ])
    expect(config).not.toContain('ROBOT_ID')
  })

  it('reads the map as RViz asks the relay for it: reliable, transient local, in the map frame', () => {
    expect(config).toMatch(/Durability Policy: Transient Local\n\s+History Policy: Keep Last\n\s+Reliability Policy: Reliable\n\s+Value: \/GRID_MAP_relayed_741\n/)
    expect(config).toMatch(/Fixed Frame: map\n/)
  })

  it('is written where the laptop terminal finds it, named after the robot', () => {
    expect(rvizConfigPath('741')).toBe('frontend/server/rviz/robot_741.rviz')
  })
})
