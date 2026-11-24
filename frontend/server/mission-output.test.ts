import { describe, expect, it } from 'vitest'
import { readMission, type OutputLine, type ReadContext } from './mission-output.ts'

/* run_demo.sh's prompts end without a newline and the answer is not echoed: what comes next joins the prompt's line */

const ROLES: Record<string, 'r1' | 'r2' | 'r3'> = { '741': 'r1', '665': 'r2', '738': 'r3' }
const ctx: ReadContext = {
  roleOf: (id) => ROLES[id] ?? null,
  defaultInstruction: 'Execute a systematic sweep of Zone A to scan for unattended or anomalous items',
  imageUrl: (path) => path,
  waypoints: () => 1,
}
const linesOf = (texts: string[]): OutputLine[] => texts.map((text, i) => ({ at: 1000 + i, text }))

// The formation, as the run of 2026-11-23 printed it: R1 stopped short of its slot
const UP_TO_PROMPT = [
  '=== Patrol: type the operator instruction and press ENTER at any time to break the loop ===',
  '',
  '[DEMO] Operator: Execute a systematic sweep of Zone A to scan for unattended or anomalous items',
  '',
  '=== Formation: every robot to its slot in the line ===',
  '',
  '[DEMO] Generating a plan...',
  '[FLEET] Not sent: no odometry yet on /ODOM_relayed_741',
  '',
  'Plan SR2-01: search zones 1–3 (about 5 min)',
  'R1: Sweep zone 1 → cordon zone 3 → return to slot 1 → patrol',
  'R2: Sweep zone 2 → cordon zone 3 → return to slot 2 → patrol',
  'R3: Sweep zone 3 → report suss item → watch suss item → return to slot 3 → patrol',
  'ALOHA: Standby → drive to box → open lid → scan contents → dock',
  '',
]
const FORMATION_AFTER_PROMPT = [
  'Operator approval (approve/deny): [FLEET] Not sent: no odometry yet on /ODOM_relayed_741',
  '[FLEET] Sent: 741 (1 WP), 665 (1 WP), 738 (1 WP) are starting',
  '[FLEET] Robot 741 WP 1/1 STOPPED SHORT — actual x=2.039 y=0.935',
  '[FLEET] Robot 741 finished its route',
  '[FLEET] Robot 665 WP 1/1 ARRIVED — actual x=3.278 y=1.550',
  '[FLEET] Robot 665 finished its route',
]

describe('readMission: prompts', () => {
  it('a plan waits for approval while it is the unfinished last line', () => {
    const read = readMission(linesOf(UP_TO_PROMPT), 'Operator approval (approve/deny): ', ctx, 0)
    expect(read.awaiting).toBe('approval')
    expect(read.plans.at(-1)).toMatchObject({ id: 'SR2-01', status: 'awaiting' })
  })

  it('it still waits once the formation drive’s output joined the prompt, and that output is read', () => {
    const read = readMission(linesOf([...UP_TO_PROMPT, ...FORMATION_AFTER_PROMPT]), '', ctx, 0)
    expect(read.awaiting).toBe('approval')
    expect(read.plans.at(-1)?.status).toBe('awaiting')
    expect(read.routes['741']).toMatchObject({ kind: 'formation', state: 'finished', last: { wp: 1, outcome: 'aborted' } })
    expect(read.warnings.map((w) => w.id)).not.toContain('fleet-odom-741') // the Sent line cleared it
  })

  it('the reply on the prompt’s line is the answer: approved, and the sweep runs the plan', () => {
    const read = readMission(
      linesOf([...UP_TO_PROMPT, 'Operator approval (approve/deny): [DEMO] Plan SR2-01 approved, waiting for every robot to reach its slot', '', '=== Sweep: every robot sweeps its zone ===']),
      '',
      ctx,
      0,
    )
    expect(read.awaiting).toBeNull()
    expect(read.plans.at(-1)?.status).toBe('executing')
    expect(read.phases.find((p) => p.id === 'approval')?.status).toBe('done')
  })

  it('the verdict prompt, answered on its own line', () => {
    const read = readMission(
      linesOf(['=== Verdict: the operator marks the box’s contents ===', '', 'Operator verdict (anomaly/clear): [DEMO] Operator verdict: CLEAR']),
      '',
      ctx,
      0,
    )
    expect(read.awaiting).toBeNull()
    expect(read.verdict?.value).toBe('clear')
  })
})

describe('readMission: the box R3 reached (demo/find_box.py)', () => {
  const found = (image: string) =>
    readMission(
      linesOf([
        '=== Sweep: every robot sweeps its zone ===',
        '[DETECT] Waiting for robot 738 to stop within 2.0 m of the box at x=1.45 y=6.51',
        `[DETECT] Box found by robot 738 at x=1.45 y=6.51 (map), 1.6 m away, confidence 1.00, image ${image}`,
      ]),
      '',
      ctx,
      0,
    )
  it('with R3’s photo', () => {
    expect(found('/ws/demo/detections/box_20261123_110000_738.jpg').detection).toMatchObject({
      by: 'r3',
      x: 1.45,
      y: 6.51,
      distM: 1.6,
      confidence: 1,
      refinements: 0,
      snapshot: { url: '/ws/demo/detections/box_20261123_110000_738.jpg', path: '/ws/demo/detections/box_20261123_110000_738.jpg' },
    })
  })
  it('without one, when R3’s camera sent no frame', () => {
    expect(found('none').detection?.snapshot).toEqual({ url: '', box: null, path: null })
  })
})

describe('readMission: the ALOHA docks where move_base could not reach (send_goal.py --dock)', () => {
  const run = (last: string[]) =>
    readMission(
      linesOf([
        '=== Aloha: drive to the box, dock and open the lid ===',
        '',
        '=== Aloha: drive to the box ===',
        '',
        '[ALOHA] Robot aloha → WP 1/1: x=1.000 y=2.000 yaw=90.0deg',
        '[ALOHA] Robot aloha WP 1/1 not reached by move_base (ABORTED): docking onto it from where it stands',
        '[ALOHA] Robot aloha docking onto its last WP',
        ...last,
      ]),
      '',
      ctx,
      0,
    )

  it('docks from where it stands, and nothing failed', () => {
    const read = run(['[ALOHA] Robot aloha docked: 1.2 cm and 0.30 deg off, after 1 correction(s)', '[ALOHA] Robot aloha finished its route in 1 s'])
    expect(read.failure).toBeNull()
    expect(read.warnings).toEqual([])
    expect(read.docking).toMatchObject({ state: 'docked' })
    expect(read.routes.aloha).toMatchObject({ state: 'finished', last: { wp: 1, outcome: 'aborted' } })
    expect(read.timeline.map((e) => e.text)).toContain('move_base could not reach WP 1/1 (aborted): docking from where it stands')
  })

  it('fails with dock.py’s reason when it stands too far off to dock', () => {
    const read = run(['[ALOHA] Robot aloha docking failed: 412.0 cm and 37.10 deg off: too far to dock, move_base did not get there'])
    expect(read.docking).toMatchObject({ state: 'failed', reason: 'docking failed: 412.0 cm and 37.10 deg off: too far to dock, move_base did not get there' })
    expect(read.failure).toMatch(/too far to dock/)
  })
})

describe('the ALOHA’s photos of the box', () => {
  // manipulator.py at the last pose but one, then inspect_box.py on the photos while the arms go home
  const PHOTOS = [
    'Pose 4/5',
    '[INSPECT] Taking photos with both wrist cameras',
    '  Photos in 0.7 s: demo/detections/contents_20261124_070334_left.jpg, demo/detections/contents_20261124_070334_right.jpg',
  ]

  it('holds the arms while both wrist cameras take their photos', () => {
    const read = readMission(linesOf(PHOTOS), '', ctx, 0)
    expect(read.arms).toEqual({ pose: 4, of: 5, state: 'holding', holdEndsAt: 1001 + 4000 })
    expect(read.contents.state).toBe('capturing')
  })

  it('then shows what the tools model found in them, side by side in one image', () => {
    const read = readMission(
      linesOf([...PHOTOS, 'Pose 5/5', '[INSPECT] Box contents: drill 0.91, pliers 0.84; image demo/detections/contents_20261124_070336.jpg']),
      '',
      ctx,
      0,
    )
    expect(read.arms).toMatchObject({ pose: 5, state: 'moving' })
    expect(read.contents).toMatchObject({
      state: 'ready',
      photo: { path: 'demo/detections/contents_20261124_070336.jpg' },
      objects: [
        { label: 'drill', confidence: 0.91, box: null },
        { label: 'pliers', confidence: 0.84, box: null },
      ],
    })
  })

  it('warns when a camera sent nothing, and still shows the other’s photo', () => {
    const read = readMission(
      linesOf([
        ...PHOTOS.slice(0, 2),
        '[INSPECT] No photo: nothing from the left wrist camera (/camera_l/color/image_throttled/compressed) in 10 s. Is robot/stream.launch running on the ALOHA?',
        '[INSPECT] Box contents: nothing found; image demo/detections/contents_20261124_070336.jpg',
      ]),
      '',
      ctx,
      0,
    )
    expect(read.warnings.map((w) => w.text)).toEqual([expect.stringMatching(/^Contents photo: No photo: nothing from the left wrist camera/)])
    expect(read.contents).toMatchObject({ state: 'ready', objects: [] })
  })
})
