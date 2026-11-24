import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { README, routesRvizCommand } from './readme-commands.ts'
import { RvizWindow, routesRviz, routesRvizPath } from './routes-rviz.ts'
import { ShellTranscript, type Shell } from './shell-transcript.ts'

/* The RViz a recording draws in: its configs, its command, and the window in a scripted laptop terminal */

const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
/** The settings, without the comments */
const settings = (config: string) => config.replace(/^#.*\n/gm, '')

describe('the dogs’ recording RViz', () => {
  const config = settings(routesRviz('dogs', ['741', '665']))

  it('shows the first dog’s map, each dog’s odometry and the routes fleet_management.py draws', () => {
    expect(config).toContain('Value: /GRID_MAP_relayed_741\n')
    expect(config).not.toContain('/GRID_MAP_relayed_665')
    expect(config).toContain('Value: /ODOM_relayed_741\n')
    expect(config).toContain('Value: /ODOM_relayed_665\n')
    expect(config).toContain('Value: /fleet_goal_markers\n')
    expect(config).toContain('Fixed Frame: map')
    expect(config).not.toMatch(/ROBOT_ID|ROBOT_DISPLAY/)
  })

  it('has only the 2D Goal Pose tool, on /goal_pose for the README’s remap to /fleet_goal', () => {
    expect(config).toContain('rviz_default_plugins/SetGoal')
    expect(config).not.toContain('SetInitialPose')
    expect(config.match(/Value: \/goal_pose\n/g)).toHaveLength(1)
  })

  it('opens with the README’s Multi-robot Step 2 line, -d in front', () => {
    expect(readme).toContain(README.rvizFleet)
    expect(routesRvizCommand('dogs', routesRvizPath('dogs'))).toBe(
      'rviz2 -d frontend/server/rviz/routes.rviz --ros-args -r /goal_pose:=/fleet_goal',
    )
  })
})

describe('the ALOHA’s recording RViz', () => {
  const config = settings(routesRviz('aloha', ['741']))

  it('says where it comes from', () => {
    expect(routesRviz('aloha', [])).toMatch(/^# Written by the Command Center from frontend\/server\/routes_aloha\.rviz: change that one\nPanels:/)
  })

  it('shows its own map, its AMCL pose and its route', () => {
    for (const topic of ['/map', '/amcl_pose', '/fleet_goal_markers']) expect(config).toContain(`Value: ${topic}\n`)
    expect(config).not.toContain('GRID_MAP')
  })

  it('never sends a goal to move_base: its goal tool goes to /fleet_goal', () => {
    expect(config).not.toContain('/move_base_simple/goal')
    expect(readme).toContain(README.rvizAloha)
    expect(routesRvizCommand('aloha', routesRvizPath('aloha'))).toBe('ROS_DOMAIN_ID=1 rviz2 -d frontend/server/rviz/routes_aloha.rviz --ros-args -r /goal_pose:=/fleet_goal')
  })
})

const PROMPT = 'root@workstation:~/ros2_ws/src/nav_cmd_bridge# '

/** bash, where rviz2 holds the terminal until Ctrl+C, or fails at once without a display */
class ScriptedRvizTerminal extends ShellTranscript implements Shell {
  readonly id = 'rviz-dogs-1'
  readonly typed: string[] = []
  activity = 'bash'
  display = true
  private rviz = false

  constructor() {
    super()
    setTimeout(() => this.append(PROMPT), 0)
  }

  setActivity(activity: string) {
    this.activity = activity
  }

  write(data: string): void {
    if (data === '\x03') {
      this.rviz = false
      return this.append(`^C\r\n${PROMPT}`)
    }
    if (this.rviz) return
    const line = data.replace(/\r$/, '')
    this.typed.push(line)
    this.append(`${line}\r\n`)
    if (/^(ROS_DOMAIN_ID=1 )?rviz2 -d /.test(line)) {
      if (this.display) this.rviz = true
      else setTimeout(() => this.append(`qt.qpa.xcb: could not connect to display\r\n${PROMPT}`), 100)
      return
    }
    setTimeout(() => this.append(PROMPT), 10)
  }
}

describe('a recording RViz window', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setUp() {
    const terminal = new ScriptedRvizTerminal()
    let changes = 0
    const window = new RvizWindow({
      which: 'dogs',
      terminal: () => terminal,
      existing: () => terminal,
      writeConfig: () => routesRvizPath('dogs'),
      onChange: () => changes++,
    })
    return { terminal, window, changes: () => changes }
  }

  it('types the README’s exports once, then rviz2, and is open while it holds the terminal', async () => {
    const t = setUp()
    const opened = t.window.open()
    expect(t.window.state).toBe('opening')
    await vi.advanceTimersByTimeAsync(4000)
    await opened
    expect(t.window.state).toBe('open')
    expect(t.terminal.typed).toEqual([
      'export ROS_DOMAIN_ID=0',
      'export FASTRTPS_DEFAULT_PROFILES_FILE=fastdds_profile.xml',
      'source install/setup.bash',
      'rviz2 -d frontend/server/rviz/routes.rviz --ros-args -r /goal_pose:=/fleet_goal',
    ])
    // Open already: nothing typed again
    await t.window.open()
    expect(t.terminal.typed).toHaveLength(4)
    const closed = t.window.close()
    await vi.advanceTimersByTimeAsync(100)
    await closed
    expect(t.window.state).toBe('closed')
    expect(t.changes()).toBeGreaterThan(0)
  })

  it('says what rviz2 printed when it does not stay open', async () => {
    const t = setUp()
    t.terminal.display = false
    const opened = t.window.open()
    const failed = expect(opened).rejects.toThrow('RViz did not open: qt.qpa.xcb: could not connect to display')
    await vi.advanceTimersByTimeAsync(4000)
    await failed
    expect(t.window.state).toBe('closed')
  })
})
