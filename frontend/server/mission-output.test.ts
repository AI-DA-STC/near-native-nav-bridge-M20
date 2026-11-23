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
