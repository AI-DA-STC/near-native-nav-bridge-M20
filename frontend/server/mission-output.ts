import type {
  ContentsFacts,
  DetectionFacts,
  LogTag,
  MissionEvent,
  Notice,
  PhaseFacts,
  PhaseId,
  PlanFacts,
  RouteFacts,
} from '../src/shared/api/mission-stream.ts'
import type { RobotKey } from '../src/shared/config/fleet.ts'

/* What demo/run_demo.sh prints, read back into the mission's facts: its phase banners (=== Sweep: … ===), its [DEMO]
 * lines and prompts, fleet_management.py's [FLEET] lines, the ALOHA's [ALOHA], arm poses and [INSPECT] lines,
 * detect_box.py's [DETECT] lines. The same reading as demo/demo_gui.py's, but a dog's waypoint ends ARRIVED, STOPPED
 * SHORT or TIMEOUT (only the ALOHA's says SUCCEEDED). Pure: the whole output is read again on every change. */

export interface OutputLine {
  at: number
  text: string
}

export const PHASE_ORDER: readonly PhaseId[] = ['ready', 'patrol', 'formation', 'approval', 'sweep', 'cordon', 'inspect', 'verdict', 'return']

/** The script's banners, by their first word */
const BANNER: Readonly<Record<string, PhaseId>> = {
  Patrol: 'patrol',
  Formation: 'formation',
  Sweep: 'sweep',
  Cordon: 'cordon',
  Aloha: 'inspect',
  Verdict: 'verdict',
  Return: 'return',
}

/** The fleet's route in each phase */
const ROUTE_KIND: Partial<Record<PhaseId, RouteFacts['kind']>> = {
  patrol: 'patrol',
  formation: 'formation',
  approval: 'formation',
  sweep: 'sweep',
  cordon: 'cordon',
  return: 'return',
}

const OUTCOME: Readonly<Record<string, NonNullable<RouteFacts['last']>['outcome']>> = {
  ARRIVED: 'succeeded',
  SUCCEEDED: 'succeeded',
  TIMEOUT: 'timeout',
  'STOPPED SHORT': 'aborted',
}

export interface MissionRead {
  phases: PhaseFacts[]
  instruction: { text: string; usedDefault: boolean; at: number } | null
  plans: PlanFacts[]
  awaiting: null | 'instruction' | 'approval' | 'verdict'
  /** Robot ID → the route it was sent last */
  routes: Record<string, RouteFacts>
  docking: { attempt: number; of: number; state: 'idle' | 'active' | 'docked' | 'failed'; reason: string | null }
  arms: { pose: number; of: number; state: 'idle' | 'moving' | 'holding' | 'done' | 'stopped' | 'failed'; holdEndsAt: number | null }
  /** move_base has not answered yet */
  navWaiting: boolean
  detection: DetectionFacts | null
  contents: ContentsFacts
  verdict: { value: 'anomaly' | 'clear'; at: number } | null
  warnings: Notice[]
  timeline: MissionEvent[]
  /** The script's exit code, once it ended ([MISSION] exit n) */
  exit: number | null
  /** The last failure it reported, for the outcome */
  failure: string | null
}

export interface ReadContext {
  /** The role a robot ID plays: 741 → r1 */
  roleOf(id: string): RobotKey | null
  defaultInstruction: string
  /** A file the scripts wrote (detections, contents photos), as the browser fetches it */
  imageUrl(path: string): string
  /** Waypoints per robot ID in each phase's file, for a route's total before the fleet says it */
  waypoints(phase: RouteFacts['kind'], id: string): number
}

const PLAN_ROLE: Readonly<Record<string, RobotKey>> = { R1: 'r1', R2: 'r2', R3: 'r3', ALOHA: 'aloha' }

/** The script's prompts. They end without a newline and the answer is not echoed (stty -echo), so whatever is printed
 * next joins their line: the formation drive's [FLEET] lines while the plan waits, or the script's own reply */
const PROMPTS: ReadonlyArray<readonly [string, 'approval' | 'verdict']> = [
  ['Operator approval (approve/deny):', 'approval'],
  ['Operator verdict (anomaly/clear):', 'verdict'],
]

function emptyRead(): MissionRead {
  return {
    phases: PHASE_ORDER.map((id) => ({ id, status: id === 'ready' ? 'active' : 'pending', startedAt: null, endedAt: null, detail: '' })),
    instruction: null,
    plans: [],
    awaiting: null,
    routes: {},
    docking: { attempt: 0, of: 1, state: 'idle', reason: null },
    arms: { pose: 0, of: 5, state: 'idle', holdEndsAt: null },
    navWaiting: false,
    detection: null,
    contents: { state: 'waiting', photo: null, objects: [] },
    verdict: null,
    warnings: [],
    timeline: [],
    exit: null,
    failure: null,
  }
}

/** Reads the run's whole output, `pending` being its last, unfinished line (a prompt waiting for an answer) */
export function readMission(lines: readonly OutputLine[], pending: string, ctx: ReadContext, startedAt: number): MissionRead {
  const read = emptyRead()
  const phase = (id: PhaseId) => read.phases.find((p) => p.id === id)!
  const active = () => read.phases.find((p) => p.status === 'active' && p.id !== 'ready')?.id ?? null
  const tagOf = (id: string): LogTag => {
    const role = ctx.roleOf(id)
    return role === 'r1' ? 'R1' : role === 'r2' ? 'R2' : role === 'r3' ? 'R3' : role === 'aloha' ? 'ALOHA' : 'FLEET'
  }
  const event = (at: number, tag: LogTag, text: string) => read.timeline.push({ id: `e${read.timeline.length}`, at, tag, text })
  const warn = (id: string, at: number, text: string, fix: string | null, robot: RobotKey | null = null, tone: Notice['tone'] = 'warn') => {
    read.warnings = [...read.warnings.filter((w) => w.id !== id), { id, tone, robot, text, fix, since: at }]
  }
  const unwarn = (prefix: string) => (read.warnings = read.warnings.filter((w) => !w.id.startsWith(prefix)))
  const start = (id: PhaseId, at: number, detail: string) => {
    const index = PHASE_ORDER.indexOf(id)
    // A new patrol after a denied plan: what came after it is to do again
    if (id === 'patrol' && phase('patrol').status !== 'pending') {
      for (const p of read.phases) if (PHASE_ORDER.indexOf(p.id) > index) Object.assign(p, { status: 'pending', endedAt: null })
      read.instruction = null
    }
    for (const p of read.phases) if (p.status === 'active' && PHASE_ORDER.indexOf(p.id) < index) Object.assign(p, { status: 'done', endedAt: at })
    const p = phase(id)
    if (p.status !== 'active') Object.assign(p, { status: 'active', startedAt: p.startedAt ?? at, endedAt: null })
    p.detail = detail
    const plan = read.plans.at(-1)
    if (plan?.status === 'approved' && index > PHASE_ORDER.indexOf('approval')) plan.status = 'executing'
  }
  /** The script asks: it waits until its reply ([DEMO] Plan … approved, [DEMO] Operator verdict: …) */
  const asked = (kind: 'approval' | 'verdict') => {
    read.awaiting = kind
    const plan = read.plans.at(-1)
    if (kind === 'approval' && plan?.status === 'generating') plan.status = 'awaiting'
  }
  let capturing: PlanFacts | null = null
  let routePhase: PhaseId = 'patrol'

  // Starting: the script's first banner ends Ready
  phase('ready').startedAt = startedAt
  for (const { at, text: raw } of lines) {
    let text = raw.trim()
    const prompt = PROMPTS.find(([p]) => text.startsWith(p))
    if (prompt) {
      asked(prompt[1])
      // What joined the prompt's line is a line of its own
      text = text.slice(prompt[0].length).trim()
    }
    if (!text) {
      capturing = null
      continue
    }
    let m: RegExpExecArray | null
    if (capturing && (m = /^([A-Z][\w ]*?):\s+(.+)$/.exec(text)) && PLAN_ROLE[m[1]]) {
      capturing.steps.push({ robot: PLAN_ROLE[m[1]], items: m[2].split(/\s*→\s*/) })
      continue
    }
    capturing = null
    if ((m = /^=== ([A-Za-z][\w ]*?):\s*(.*?)\s*===$/.exec(text))) {
      const id = BANNER[m[1].split(' ')[0]]
      if (!id) continue
      if (phase('ready').status === 'active') Object.assign(phase('ready'), { status: 'done', endedAt: at })
      // run_aloha.sh's own "=== Aloha: … ===" banners go on with the inspection
      if (phase(id).status !== 'active') start(id, at, m[2])
      else phase(id).detail = m[2]
      routePhase = id
      if (id === 'patrol') read.awaiting = 'instruction'
      if (id === 'verdict') read.awaiting = 'verdict'
      continue
    }
    if ((m = /^Plan (\S+?):\s*(.*?)(?:\s*\((.+)\))?$/.exec(text)) && read.plans.at(-1)?.status === 'generating' && !read.plans.at(-1)!.id) {
      const plan = read.plans.at(-1)!
      plan.id = m[1]
      plan.title = m[2]
      plan.summary = m[3] ?? null
      capturing = plan
      continue
    }
    if ((m = /^\[DEMO\]\s*(.*)$/.exec(text))) {
      const said = m[1]
      let d: RegExpExecArray | null
      if ((d = /^Operator:\s*(.*)$/.exec(said))) {
        read.instruction = { text: d[1], usedDefault: d[1] === ctx.defaultInstruction, at }
        read.awaiting = null
        event(at, 'OPERATOR', `Instruction: ${d[1]}`)
      } else if (/^Generating a plan/.test(said)) {
        start('approval', at, 'Generating a plan')
        read.plans.push({ n: read.plans.length + 1, id: null, title: null, summary: null, instruction: read.instruction?.text ?? ctx.defaultInstruction, status: 'generating', steps: [], createdAt: at, decidedAt: null })
        event(at, 'PLAN', 'Generating a plan')
      } else if ((d = /^Plan (\S+) (approved|denied)/.exec(said))) {
        const plan = read.plans.at(-1)
        if (plan) Object.assign(plan, { status: d[2] === 'approved' ? 'approved' : 'denied', decidedAt: at })
        read.awaiting = null
        if (d[2] === 'denied') Object.assign(phase('approval'), { status: 'pending', endedAt: at })
        else Object.assign(phase('approval'), { status: 'done', endedAt: at })
        event(at, 'OPERATOR', `Plan ${d[1]} ${d[2]}`)
      } else if ((d = /^Operator verdict:\s*(ANOMALY|CLEAR)/.exec(said))) {
        read.verdict = { value: d[1] === 'ANOMALY' ? 'anomaly' : 'clear', at }
        read.awaiting = null
        event(at, 'OPERATOR', `Verdict: ${d[1]}`)
      } else {
        const p = active()
        if (p) phase(p).detail = said
        event(at, 'PLAN', said)
      }
      continue
    }
    if ((m = /^\[FLEET\]\s*(.*)$/.exec(text))) {
      readFleet(m[1], at)
      continue
    }
    if ((m = /^\[ALOHA\]\s*(.*)$/.exec(text))) {
      readAloha(m[1], at)
      continue
    }
    if ((m = /^\[DETECT\]\s*(.*)$/.exec(text))) {
      readDetect(m[1], at)
      continue
    }
    if ((m = /^\[INSPECT\]\s*(.*)$/.exec(text))) {
      readInspect(m[1], at)
      continue
    }
    if ((m = /^Pose (\d+)\/(\d+)$/.exec(text))) {
      read.arms = { pose: Number(m[1]), of: Number(m[2]), state: 'moving', holdEndsAt: null }
      event(at, 'ALOHA', `Arms to pose ${m[1]}/${m[2]}`)
      continue
    }
    if (/^Done: the arms/.test(text)) {
      read.arms = { ...read.arms, state: 'done', holdEndsAt: null }
      event(at, 'ALOHA', text)
      continue
    }
    if (/^Stopped: the arms/.test(text)) {
      read.arms = { ...read.arms, state: 'stopped', holdEndsAt: null }
      continue
    }
    if (/^Still .* off after/.test(text)) {
      warn('arms', at, `ALOHA arms: ${text}`, null, 'aloha')
      continue
    }
    if ((m = /^\[MISSION\] exit (\d+)$/.exec(text))) {
      read.exit = Number(m[1])
      continue
    }
    if (/^No .*\.json/.test(text) || /^(Traceback|.*Error:)/.test(text)) read.failure = text
  }

  // The prompts end without a newline: the question waiting now
  const ask = pending.trim()
  const prompt = PROMPTS.find(([p]) => ask.startsWith(p) || ask.endsWith(p))
  if (prompt) asked(prompt[1])
  return read

  function route(id: string, at: number): RouteFacts {
    const kind = ROUTE_KIND[routePhase] ?? 'patrol'
    const current = read.routes[id]
    if (current && current.kind === kind) return current
    const total = ctx.waypoints(kind, id)
    const fresh: RouteFacts = { kind, total, reached: 0, target: total ? 1 : null, lap: kind === 'patrol' ? 1 : null, state: 'driving', goal: null, distanceRemaining: null, legLength: null, last: null }
    void at
    read.routes[id] = fresh
    return fresh
  }

  function readFleet(said: string, at: number) {
    let m: RegExpExecArray | null
    if ((m = /^Sent: (.*) are starting$/.exec(said))) {
      unwarn('fleet-')
      for (const r of m[1].matchAll(/(\S+) \((\d+) WP\)/g)) {
        delete read.routes[r[1]]
        const facts = route(r[1], at)
        Object.assign(facts, { total: Number(r[2]), reached: 0, target: 1, state: 'driving', last: null })
      }
      event(at, 'FLEET', `Sent: ${m[1]}`)
      return
    }
    if ((m = /^Not sent: (.*)$/.exec(said))) {
      const why = m[1]
      for (const d of why.matchAll(/\/goal_pose_(\S+?)(?=[,\s]|$)/g)) warn(`fleet-deaf-${d[1]}`, at, `Robot ${d[1]} not connected`, 'is its nav bridge running?', ctx.roleOf(d[1]))
      for (const d of why.matchAll(/\/ODOM_relayed_(\S+?)(?=[,\s]|$)/g)) warn(`fleet-odom-${d[1]}`, at, `No position yet from robot ${d[1]}`, 'is its relay running?', ctx.roleOf(d[1]))
      if (!/goal_pose_|ODOM_relayed_/.test(why)) warn('fleet-other', at, `Fleet: ${why}`, null)
      return
    }
    if ((m = /^Robot (\S+) WP (\d+)\/(\d+) (ARRIVED|SUCCEEDED|TIMEOUT|STOPPED SHORT)/.exec(said))) {
      const facts = route(m[1], at)
      const wp = Number(m[2])
      Object.assign(facts, { total: Number(m[3]), reached: wp, last: { wp, outcome: OUTCOME[m[4]], at } })
      if (m[4] !== 'ARRIVED' && m[4] !== 'SUCCEEDED') event(at, tagOf(m[1]), `Robot ${m[1]} could not reach WP ${wp}/${m[3]} (${m[4].toLowerCase()}), going on`)
      return
    }
    if ((m = /^Robot (\S+) → WP (\d+)\/(\d+)/.exec(said))) {
      Object.assign(route(m[1], at), { target: Number(m[2]), total: Number(m[3]), state: 'driving' })
      return
    }
    if ((m = /^Robot (\S+) lap (\d+)$/.exec(said))) {
      Object.assign(route(m[1], at), { lap: Number(m[2]), reached: 0 })
      return
    }
    if ((m = /^Robot (\S+) finished its route/.exec(said))) {
      const facts = route(m[1], at)
      Object.assign(facts, { state: 'finished', reached: facts.total, target: null })
      event(at, tagOf(m[1]), `Robot ${m[1]} finished its ${facts.kind} route`)
      return
    }
    if ((m = /^Robot (\S+) stopped at/.exec(said))) Object.assign(route(m[1], at), { state: 'stopped', target: null })
  }

  function aloha(at: number): RouteFacts {
    const current = read.routes.aloha
    if (current?.kind === 'aloha') return current
    const total = ctx.waypoints('aloha', 'aloha')
    const fresh: RouteFacts = { kind: 'aloha', total, reached: 0, target: total ? 1 : null, lap: null, state: 'driving', goal: null, distanceRemaining: null, legLength: null, last: null }
    void at
    read.routes.aloha = fresh
    return fresh
  }

  function readAloha(said: string, at: number) {
    let m: RegExpExecArray | null
    if (/^Waiting for move_base/.test(said)) {
      read.navWaiting = true
      warn('aloha-nav', at, 'ALOHA: move_base does not answer yet', 'is aloha/bridge.sh running, and its navigation?', 'aloha')
      return
    }
    read.navWaiting = false
    unwarn('aloha-nav')
    if ((m = /^Robot \S+ → WP (\d+)\/(\d+)/.exec(said))) {
      Object.assign(aloha(at), { target: Number(m[1]), total: Number(m[2]), state: 'driving' })
      event(at, 'ALOHA', `To WP ${m[1]}/${m[2]}`)
    } else if ((m = /^Robot \S+ WP (\d+)\/(\d+) SUCCEEDED/.exec(said))) {
      const wp = Number(m[1])
      Object.assign(aloha(at), { reached: wp, last: { wp, outcome: 'succeeded', at } })
    } else if ((m = /^Robot \S+ WP (\d+)\/(\d+) not reached by move_base \(([^)]*)\)/.exec(said))) {
      // The dock pose, by the box: send_goal.py --dock has dock.py take it from where the base stands
      const wp = Number(m[1])
      Object.assign(aloha(at), { target: null, last: { wp, outcome: /ABORTED/.test(m[3]) ? 'aborted' : 'timeout', at } })
      event(at, 'ALOHA', `move_base could not reach WP ${m[1]}/${m[2]} (${m[3].toLowerCase()}): docking from where it stands`)
    } else if (/^Robot \S+ docking onto/.test(said)) {
      read.docking = { attempt: 1, of: 1, state: 'active', reason: null }
      event(at, 'ALOHA', 'Docking onto the box')
    } else if ((m = /^Robot \S+ docked: (.*?)(?:, after (\d+) correction)?/.exec(said))) {
      const corrections = m[2] ? Number(m[2]) : 1
      read.docking = { attempt: corrections, of: corrections, state: 'docked', reason: null }
      event(at, 'ALOHA', `Docked: ${m[1]}`)
    } else if (/^Robot \S+ finished its route/.test(said)) {
      const facts = aloha(at)
      Object.assign(facts, { state: 'finished', reached: facts.total, target: null })
    } else {
      // Anything else is a failure: send_goal.py's reason
      const reason = said.replace(/^Robot \S+ /, '')
      if (/dock/i.test(said)) read.docking = { ...read.docking, state: 'failed', reason }
      else Object.assign(aloha(at), { state: 'failed', target: null })
      read.failure = `ALOHA: ${said}`
      warn('aloha-fail', at, `ALOHA: ${reason}`, null, 'aloha', 'fault')
      event(at, 'FAULT', `ALOHA: ${said}`)
    }
  }

  function readDetect(said: string, at: number) {
    const m = /^Box (found|update) by robot (\S+) (?:at x=(\S+) y=(\S+) \(map\), ([\d.]+) m away|position not measured yet), confidence ([\d.]+), image (.+)$/.exec(said)
    if (!m) {
      if (/^No video/.test(said)) warn('detect', at, `Detector: ${said}`, null, 'r3')
      event(at, 'DETECT', said)
      return
    }
    const by = ctx.roleOf(m[2]) ?? 'r3'
    const x = m[3] ? Number(m[3]) : null
    const y = m[4] ? Number(m[4]) : null
    if (x === null || y === null) return
    const dist = Number(m[5])
    const previous = read.detection
    read.detection = {
      by,
      x,
      y,
      distM: dist,
      confidence: Number(m[6]),
      uncertaintyM: Math.max(0.2, dist * 0.2),
      size: { w: 0.6, h: 0.38 },
      foundAt: previous?.foundAt ?? at,
      refinedAt: m[1] === 'update' ? at : null,
      refinements: (previous?.refinements ?? -1) + 1,
      // demo/find_box.py says "image none" when the robot's camera sent no frame
      snapshot: m[7] === 'none' ? { url: '', box: null, path: null } : { url: ctx.imageUrl(m[7]), box: null, path: m[7] },
    }
    event(at, 'DETECT', `Box ${m[1]} by robot ${m[2]} at x ${x.toFixed(2)}, y ${y.toFixed(2)}`)
  }

  function readInspect(said: string, at: number) {
    let m: RegExpExecArray | null
    // manipulator.py at the last pose but one: "Taking photos with both wrist cameras" (inspect_box.py's own photo before)
    if (/^Taking (?:a photo|photos)/.test(said)) {
      read.contents = { ...read.contents, state: 'capturing' }
      // The photos (about 1 s), then manipulator.py's PHOTO_HOLD_S (2 s) and --pause (1 s)
      read.arms = { ...read.arms, state: 'holding', holdEndsAt: at + 4000 }
      event(at, 'INSPECT', 'Photographing the box with both wrist cameras')
    } else if ((m = /^Box contents: (.*); image (.+)$/.exec(said))) {
      const objects =
        m[1] === 'nothing found'
          ? []
          : m[1].split(', ').map((item) => {
              const cut = item.lastIndexOf(' ')
              return { label: item.slice(0, cut), confidence: Number(item.slice(cut + 1)) || 0, box: null }
            })
      read.contents = { state: 'ready', photo: { url: ctx.imageUrl(m[2]), at, path: m[2] }, objects }
      if (read.arms.state === 'holding') read.arms = { ...read.arms, state: 'moving', holdEndsAt: null }
      event(at, 'INSPECT', `Box contents: ${m[1]}`)
    } else {
      read.contents = { ...read.contents, state: 'failed' }
      warn('inspect', at, `Contents photo: ${said}`, null, 'aloha')
      event(at, 'WARN', said)
    }
  }
}
