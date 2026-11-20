import { describe, expect, it } from 'vitest'
import { readFleetOutput } from './fleet-output.ts'

/* What record_waypoints.sh and fleet_management.py --record print, line for line as the scripts write them */

const START = [
  '',
  '=== sweep (multi-waypoint, R1=741 R2=665 R3=738): each robot\'s sweep of zone 1, 2, 3 in order, ENTER at every waypoint; R3 ends next to the box ===',
  '',
  '[FLEET] multi-waypoint: recording robots 741 in that order into demo/waypoints/2026-11-20_15-02-10/sweep.json; waypoints are drawn on /fleet_goal_markers',
  '',
  '>>> Drive the current robot to a waypoint, then ENTER records its pose. n + ENTER: next robot, u + ENTER: undo its last waypoint, c + ENTER: clear all, w + ENTER: save and exit <<<',
  '',
]

const read = (...lines: string[]) => readFleetOutput([...START, ...lines].join('\n'))

describe('reading a recording', () => {
  it('takes keys once fleet_management.py shows its prompt', () => {
    expect(readFleetOutput(START.slice(0, 4).join('\n')).ready).toBe(false)
    expect(read().ready).toBe(true)
  })

  it('collects the waypoints as recorded, yaw in radians', () => {
    const r = read('', '[FLEET] Robot 741 WP 1: x=2.764 y=-9.190 yaw=-53.2deg', '', '[FLEET] Robot 741 WP 2: x=5.994 y=-9.643 yaw=-27.5deg')
    expect(r.waypoints).toEqual([
      { x: 2.764, y: -9.19, yaw: -0.929 },
      { x: 5.994, y: -9.643, yaw: -0.48 },
    ])
    expect(r.message).toBeNull()
  })

  it('follows undo and clear', () => {
    const wp = (n: number) => `[FLEET] Robot 741 WP ${n}: x=${n}.000 y=0.000 yaw=0.0deg`
    expect(read(wp(1), wp(2), '[FLEET] Robot 741: dropped WP 2, 1 left').waypoints).toHaveLength(1)
    expect(read(wp(1), wp(2), '[FLEET] Cleared all waypoints; waypoints go to robot 741').waypoints).toEqual([])
    expect(read(wp(1), '[FLEET] Robot 741: dropped WP 1, 0 left', wp(1)).waypoints).toEqual([{ x: 1, y: 0, yaw: 0 }])
  })

  it('says why a waypoint was not recorded or not saved', () => {
    expect(read('[FLEET] Not recorded: no odometry yet on /ODOM_relayed_741').message).toEqual({
      text: 'Not recorded: no odometry yet on /ODOM_relayed_741',
      tone: 'fault',
    })
    expect(read('[FLEET] Not saved: robot 741 has fewer than 3 waypoints (a patrol loops a closed shape)').message?.tone).toBe('fault')
    expect(read('[FLEET] Robot 741 already has its waypoint (u + ENTER undoes it, n + ENTER: next robot)').message?.tone).toBe('warn')
  })

  it('knows a saved recording', () => {
    const r = read('[FLEET] Robot 741 WP 1: x=1.000 y=2.000 yaw=90.0deg', '[FLEET] Saved 741 (1 WP) to demo/waypoints/x/formation.json, kept robot 665, 738')
    expect(r.saved).toBe('Saved 741 (1 WP) to demo/waypoints/x/formation.json, kept robot 665, 738')
    expect(r.waypoints).toEqual([{ x: 1, y: 2, yaw: 1.571 }])
  })

  it('knows a recording that could not run', () => {
    expect(readFleetOutput('\n=== cordon: none of ONLY=738 takes part, skipped ===\n').error).toBe('738 takes no part in the cordon')
    const traceback = ['Traceback (most recent call last):', '  File "scripts/fleet_management.py", line 30, in <module>', '    import rclpy', "ModuleNotFoundError: No module named 'rclpy'"]
    expect(readFleetOutput(traceback.join('\n')).error).toBe("ModuleNotFoundError: No module named 'rclpy'")
  })
})
