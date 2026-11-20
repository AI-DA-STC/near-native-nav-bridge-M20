import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlanRecording, PoseFact } from '../src/shared/api/setup-protocol.ts'
import { RouteRecorder } from './route-recorder.ts'
import { ShellTranscript, type Shell } from './shell-transcript.ts'

/* The recorder against a scripted laptop terminal: bash, demo/record_waypoints.sh and fleet_management.py --record */

const PROMPT = 'root@workstation:~/ros2_ws/src/nav_cmd_bridge# '
const ASK = '\r\n>>> Drive the current robot to a waypoint, then ENTER records its pose. n + ENTER: next robot, u + ENTER: undo its last waypoint, c + ENTER: clear all, w + ENTER: save and exit <<<\r\n\r\n'

class ScriptedLaptop extends ShellTranscript implements Shell {
  readonly id = 'routes-1'
  readonly typed: string[] = []
  activity = 'bash'
  private recording: { robot: string; file: string; wps: number } | null = null

  constructor() {
    super()
    setTimeout(() => this.append(PROMPT), 0)
  }

  setActivity(activity: string) {
    this.activity = activity
  }

  write(data: string): void {
    if (this.recording) return this.key(data)
    const line = data.replace(/\r$/, '')
    this.typed.push(line)
    this.append(`${line}\r\n`)
    const m = /^ONLY="(\w+)" (?:APPEND=1 )?WAYPOINTS=(\S+) demo\/record_waypoints\.sh (\w+)$/.exec(line)
    setTimeout(() => {
      if (!m) return this.append(PROMPT)
      this.recording = { robot: m[1], file: `${m[2]}/${m[3]}.json`, wps: 0 }
      this.append(`\r\n=== ${m[3]} (single-waypoint, R1=741 R2=665 R3=738): R1, R2, R3 to slots 1, 2, 3 of the horizontal line, ENTER once per robot ===\r\n\r\n`)
      this.append(`[FLEET] single-waypoint: recording robots ${m[1]} in that order into ${this.recording.file}; waypoints are drawn on /fleet_goal_markers\r\n${ASK}`)
    }, 50)
  }

  private key(data: string) {
    const r = this.recording!
    if (data === '\x03') {
      this.recording = null
      return this.append(`^C${PROMPT}`)
    }
    this.append(data.replace('\r', '\r\n'))
    const said = (line: string) => this.append(`${line}\r\n${ASK}`)
    if (data === '\r') {
      r.wps++
      return said(`[FLEET] Robot ${r.robot} WP ${r.wps}: x=1.250 y=-0.500 yaw=90.0deg`)
    }
    if (data === 'u\r') return said(`[FLEET] Robot ${r.robot}: dropped WP ${r.wps}, ${--r.wps} left`)
    if (data === 'w\r') {
      if (!r.wps) return said(`[FLEET] Not saved: no waypoints yet for robot ${r.robot}`)
      this.recording = null
      return this.append(`[FLEET] Saved ${r.robot} (${r.wps} WP) to ${r.file}, kept robot 665, 738\r\n${PROMPT}`)
    }
  }
}

function setUp() {
  const terminal = new ScriptedLaptop()
  const saved: Array<{ plan: string; recording: PlanRecording }> = []
  let posed: ((pose: PoseFact) => void) | null = null
  let stops = 0
  const recorder = new RouteRecorder({
    terminal: () => terminal,
    folderForShell: (plan) => `demo/waypoints/${plan}`,
    watchOdom: (_robot, onPose) => {
      posed = onPose
      return () => stops++
    },
    onChange: () => undefined,
    onSaved: (plan, recording) => saved.push({ plan, recording }),
  })
  return { terminal, recorder, saved, pose: (p: PoseFact) => posed?.(p), stops: () => stops }
}

const settle = () => vi.advanceTimersByTimeAsync(200)

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('recording a robot’s waypoints', () => {
  it('types the README’s exports once, then record_waypoints.sh for the robot and phase', async () => {
    const t = setUp()
    const started = t.recorder.start('2026-11-20_15-02-10', 'formation', '741', false)
    await vi.advanceTimersByTimeAsync(500)
    await started
    await settle()
    expect(t.terminal.typed).toEqual([
      'export ROS_DOMAIN_ID=0',
      'export FASTRTPS_DEFAULT_PROFILES_FILE=fastdds_profile.xml',
      'source install/setup.bash',
      'ONLY="741" WAYPOINTS=demo/waypoints/2026-11-20_15-02-10 demo/record_waypoints.sh formation',
    ])
    expect(t.recorder.facts).toMatchObject({ state: 'recording', robot: '741', phase: 'formation', waypoints: [] })
  })

  it('records, undoes and saves with fleet_management.py’s keys, and notes what was saved', async () => {
    const t = setUp()
    const started = t.recorder.start('2026-11-20_15-02-10', 'formation', '741', false)
    await vi.advanceTimersByTimeAsync(500)
    await started
    await settle()
    t.recorder.key('record')
    await settle()
    t.recorder.key('record')
    await settle()
    t.recorder.key('undo')
    await settle()
    expect(t.recorder.facts?.waypoints).toEqual([{ x: 1.25, y: -0.5, yaw: 1.571 }])
    t.pose({ x: 1.3, y: -0.4, yaw: 88, at: Date.now() })
    expect(t.recorder.facts?.pose).toMatchObject({ x: 1.3, y: -0.4 })
    t.recorder.key('save')
    await settle()
    expect(t.recorder.facts).toMatchObject({ state: 'saved', message: { text: 'Saved 741 (1 WP) to demo/waypoints/2026-11-20_15-02-10/formation.json, kept robot 665, 738' } })
    expect(t.saved).toEqual([{ plan: '2026-11-20_15-02-10', recording: { phase: 'formation', robot: '741', append: false, waypoints: 1, at: expect.any(Number) } }])
    expect(t.stops()).toBe(1)
    expect(() => t.recorder.key('record')).toThrow(/No recording/)
  })

  it('says why it did not save, and keeps recording', async () => {
    const t = setUp()
    const started = t.recorder.start('p', 'formation', '741', false)
    await vi.advanceTimersByTimeAsync(500)
    await started
    await settle()
    t.recorder.key('save')
    await settle()
    expect(t.recorder.facts).toMatchObject({ state: 'recording', message: { text: 'Not saved: no waypoints yet for robot 741', tone: 'fault' } })
  })

  it('cancels with Ctrl+C, saving nothing, and types the exports only once per terminal', async () => {
    const t = setUp()
    let started = t.recorder.start('p', 'formation', '741', false)
    await vi.advanceTimersByTimeAsync(500)
    await started
    await settle()
    const cancelled = t.recorder.cancel()
    await settle()
    await cancelled
    expect(t.recorder.facts?.state).toBe('cancelled')
    expect(t.saved).toEqual([])
    started = t.recorder.start('p', 'formation', '665', false)
    await vi.advanceTimersByTimeAsync(500)
    await started
    expect(t.terminal.typed.filter((l) => l.startsWith('export ') || l.startsWith('source '))).toHaveLength(3)
  })
})
