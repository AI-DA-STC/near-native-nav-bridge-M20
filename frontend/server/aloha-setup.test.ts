import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PoseFact, PromptChoice, RelayState, SetupPrompt } from '../src/shared/api/setup-protocol.ts'
import {
  ALOHA_STACK,
  ALOHA_STEPS,
  bridgeProgress,
  bridgeYamlTopics,
  pendingAlohaStep,
  runAlohaSetup,
  shortNode,
  stackChecks,
  tmuxAttached,
  type AlohaSetupContext,
} from './aloha-setup.ts'
import type { SystemState } from './ros1-master.ts'
import { Aborted, ShellTranscript, type Shell } from './shell-transcript.ts'

/* The ALOHA's setup against a scripted ALOHA: its ssh, start_aloha.sh and tmux, its ROS master, and the laptop's bridge */

const IP = '192.168.123.200'
const ROBOT = { id: 'aloha', ip: IP, user: 'agilex' }
const TMUX_DRAW =
  '\x1b[?1049h\x1b[H\x1b[2J\x1b[?25l\x1b[1;1Hroscore\r\n\x1b[40;1H\x1b[30m\x1b[42m[aloha] 0:roscore* 1:cameras- 2:arms  3:lidar  4:base  5:navigation  6:stream  7:dock\x1b[0m'

const YAML_TOPICS = bridgeYamlTopics(readFileSync(new URL('../../aloha/bridge.yaml', import.meta.url), 'utf8'))

interface AlohaScript {
  password: string
  /** start_aloha.sh's tmux session is already there */
  running: boolean
  /** How long parameter_bridge takes per topic: a call or more to the ALOHA's master each */
  bridgeEveryMs?: number
  /** It stops making progress after this many topics */
  bridgeStallsAfter?: number
}

class ScriptedAloha extends ShellTranscript implements Shell {
  readonly typed: string[] = []
  place: 'laptop' | 'aloha' | 'tmux' = 'laptop'
  private awaiting = false
  private foreground: 'bridge' | 'rviz' | null = null
  private timers: Array<ReturnType<typeof setTimeout>> = []
  private readonly script: AlohaScript

  constructor(script: AlohaScript) {
    super()
    this.script = script
    this.later(() => this.append(this.prompt()))
  }

  private prompt() {
    return this.place === 'laptop' ? 'root@workstation:~/ros2_ws/src/nav_cmd_bridge# ' : '\x1b[01;32magilex@agilex\x1b[00m:\x1b[01;34m~\x1b[00m$ '
  }

  private later(fn: () => void, ms = 0) {
    this.timers.push(setTimeout(fn, ms))
  }

  write(data: string): void {
    if (data === '\x03') {
      this.foreground = null
      return this.append(`^C\r\n${this.prompt()}`)
    }
    if (data === '\x02d') {
      if (this.place !== 'tmux') return
      this.place = 'aloha'
      return this.append(`\x1b[?1049l[detached (from session aloha)]\r\n${this.prompt()}`)
    }
    const line = data.replace(/\r$/, '')
    if (this.awaiting) {
      this.awaiting = false
      if (line !== this.script.password) return this.append(`\r\nPermission denied, please try again.\r\nagilex@${IP}'s password: `)
      this.place = 'aloha'
      return this.append(`\r\nWelcome to Ubuntu 20.04.6 LTS\r\n${this.prompt()}`)
    }
    if (this.foreground || this.place === 'tmux') return
    this.typed.push(line)
    this.append(`${line}\r\n`)
    this.later(() => this.run(line))
  }

  private run(line: string) {
    const done = (output = '') => this.append(output + this.prompt())
    if (line === `ssh agilex@${IP}` && this.place === 'laptop') {
      this.awaiting = true
      return this.append(`agilex@${IP}'s password: `)
    }
    if (line === 'bash start_aloha.sh' && this.place === 'aloha') {
      if (this.script.running) return done('Already running: tmux attach -t aloha, or bash start_aloha.sh stop\r\n')
      return this.later(() => {
        this.script.running = true
        this.place = 'tmux'
        this.append(TMUX_DRAW)
      }, 300)
    }
    if (line === 'bash start_aloha.sh stop' && this.place === 'aloha') {
      return this.later(() => {
        this.script.running = false
        done()
      }, 500)
    }
    if (line === 'aloha/bridge.sh' && this.place === 'laptop') {
      this.foreground = 'bridge'
      // bridge.yaml's topics one by one, as parameter_bridge prints them, then its services and the first messages
      const every = this.script.bridgeEveryMs ?? 50
      const topics = YAML_TOPICS.slice(0, this.script.bridgeStallsAfter ?? YAML_TOPICS.length)
      topics.forEach((topic, i) =>
        this.later(() => {
          if (this.foreground !== 'bridge') return
          this.append(`Trying to create bidirectional bridge for topic '${topic}' with ROS 2 type 'some/msg/Type'\r\n[INFO] [1795160540.${i}] [ros_bridge]: create bidirectional bridge for topic ${topic}\r\n`)
        }, 200 + i * every),
      )
      if (topics.length === YAML_TOPICS.length) {
        this.later(() => {
          if (this.foreground === 'bridge') this.append("The parameter 'services_1_to_2' either doesn't exist or isn't an array\r\n")
        }, 300 + topics.length * every)
      }
      return
    }
    if (line.startsWith('ROS_DOMAIN_ID=1 rviz2 -d ') && this.place === 'laptop') {
      this.foreground = 'rviz'
      return
    }
    if (line === 'exit' && this.place === 'aloha') {
      this.place = 'laptop'
      return done(`logout\r\nConnection to ${IP} closed.\r\n`)
    }
    if (line.startsWith('export ') || line.startsWith('source ')) return done()
    return done(`bash: ${line.split(' ')[0]}: command not found\r\n`)
  }
}

/** Every part's topics published, but those in `without` */
function master(without: string[] = []): SystemState {
  const publishers = new Map<string, string[]>()
  for (const part of ALOHA_STACK) if (!without.includes(part.label)) for (const topic of part.topics) publishers.set(topic, [`/${part.window}_node`])
  return { publishers, subscribers: new Map() }
}

function setUp(script: Partial<AlohaScript> = {}, answers: PromptChoice[] = [], options: { down?: string[]; bridged?: boolean; masterMs?: number } = {}) {
  const aloha: AlohaScript = { password: 'agx', running: false, ...script }
  const robot = new ScriptedAloha(aloha)
  const laptop = new ScriptedAloha(aloha)
  const rviz = new ScriptedAloha(aloha)
  // What RViz and AMCL say, fed by a test: the operator's 2D Pose Estimate, then AMCL's pose
  const estimates: Array<(pose: PoseFact) => void> = []
  const amclPoses: Array<(pose: PoseFact) => void> = []
  const updated: SetupPrompt[] = []
  const steps = ALOHA_STEPS.map((key) => pendingAlohaStep(key, ROBOT))
  const asked: SetupPrompt[] = []
  const relay: { state: RelayState; rate: number | null } = { state: 'none', rate: null }
  let bridging = options.bridged ?? false
  const abort = new AbortController()
  const ctx: AlohaSetupContext = {
    robot: ROBOT,
    password: () => 'agx',
    laptopHost: 'workstation',
    signal: abort.signal,
    robotShell: () => robot,
    laptopShell: () => laptop,
    step: (key) => steps.find((s) => s.key === key)!,
    changed: () => undefined,
    ask: (_key, prompt) => {
      asked.push(prompt)
      const choice = answers.shift()
      return new Promise((resolve, reject) => {
        abort.signal.addEventListener('abort', () => reject(new Aborted()))
        if (choice) setTimeout(() => resolve(choice), 500)
      })
    },
    setActivity: () => undefined,
    setRelay: (state, rate) => {
      relay.state = state
      if (rate !== undefined) relay.rate = rate
    },
    bridgeLaunched: () => {
      bridging = true
    },
    masterState: async () => {
      if (options.masterMs) await new Promise((resolve) => setTimeout(resolve, options.masterMs))
      if (!aloha.running) throw new Error('connect ECONNREFUSED')
      return master(options.down)
    },
    domainTopics: async () => (bridging ? ['/scan', '/map', '/move_base/status', '/puppet/joint_left', '/aloha/dock/result', '/rosout'] : ['/rosout']),
    topicRate: async () => 10.04,
    rvizShell: () => rviz,
    writeRvizConfig: () => undefined,
    watchInitialPose: (onPose) => {
      estimates.push(onPose)
      return () => estimates.splice(estimates.indexOf(onPose), 1)
    },
    watchAmclPose: (onPose) => {
      amclPoses.push(onPose)
      return () => amclPoses.splice(amclPoses.indexOf(onPose), 1)
    },
    updatePrompt: (_key, prompt) => {
      updated.push(prompt)
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
  return { ctx, robot, laptop, rviz, steps, asked, relay, abort, step: ctx.step, aloha, estimates, amclPoses, updated }
}

async function finish<T>(promise: Promise<T>): Promise<T> {
  let settled = false
  promise.then(
    () => (settled = true),
    () => (settled = true),
  )
  for (let i = 0; i < 3000 && !settled; i++) await vi.advanceTimersByTimeAsync(100)
  return promise
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the ALOHA’s setup', () => {
  it('logs in as agilex, runs start_aloha.sh, checks its stack, bridges it here, then localizes it in RViz', async () => {
    const t = setUp({}, ['localized'])
    await finish(runAlohaSetup(t.ctx))
    expect(t.robot.typed).toEqual([`ssh agilex@${IP}`, 'bash start_aloha.sh'])
    expect(t.laptop.typed).toEqual(['export FASTRTPS_DEFAULT_PROFILES_FILE=fastdds_profile.xml', 'aloha/bridge.sh'])
    // RViz in a terminal of its own: the laptop one holds the bridge
    expect(t.rviz.typed).toEqual(['export FASTRTPS_DEFAULT_PROFILES_FILE=fastdds_profile.xml', 'source install/setup.bash', 'ROS_DOMAIN_ID=1 rviz2 -d frontend/server/rviz/aloha.rviz'])
    expect(t.steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done', 'done'])
    expect(t.step('stack').checks.map((c) => [c.label, c.ok])).toEqual(ALOHA_STACK.map((p) => [p.label, true]))
    expect(t.step('bridge').checks.find((c) => c.label === '/scan rate')).toEqual({ label: '/scan rate', ok: true, value: '10.0 Hz' })
    expect(t.relay).toEqual({ state: 'running', rate: 10.04 })
    // The robot terminal stays in start_aloha.sh's tmux, as by hand
    expect(t.robot.place).toBe('tmux')
  })

  it('keeps a session already running, without starting a second one', async () => {
    const t = setUp({ running: true }, ['keep-aloha', 'localized'])
    await finish(runAlohaSetup(t.ctx))
    expect(t.asked[0]).toEqual({ kind: 'aloha-running' })
    expect(t.robot.typed.filter((l) => l === 'bash start_aloha.sh')).toHaveLength(1)
    expect(t.step('start').commands.map((c) => c.status)).toEqual(['skipped'])
    expect(t.steps.every((s) => s.status === 'done')).toBe(true)
  })

  it('restarts a session already running when asked: stop, then start', async () => {
    const t = setUp({ running: true }, ['restart-aloha', 'localized'])
    await finish(runAlohaSetup(t.ctx))
    expect(t.robot.typed).toEqual([`ssh agilex@${IP}`, 'bash start_aloha.sh', 'bash start_aloha.sh stop', 'bash start_aloha.sh'])
    expect(t.step('start').commands.map((c) => [c.text, c.status])).toEqual([
      ['bash start_aloha.sh', 'failed'],
      ['bash start_aloha.sh stop', 'done'],
      ['bash start_aloha.sh', 'done'],
    ])
    expect(t.robot.place).toBe('tmux')
  })

  it('fails the stack check with the parts that did not come up', async () => {
    const t = setUp({}, [], { down: ['Navigation'] })
    await expect(finish(runAlohaSetup(t.ctx))).rejects.toThrow(/Not up after 90 s: Navigation/)
    expect(t.step('stack').checks.find((c) => c.label === 'Navigation')).toMatchObject({ ok: false, value: 'no /move_base/status (+2)' })
    expect(t.step('bridge').status).toBe('pending')
  })

  it('waits for a bridge that is slow to start, as long as it bridges topic after topic, and says the link is slow', async () => {
    // 4 s a topic, as over the ALOHA's slow WiFi: two minutes for bridge.yaml
    const t = setUp({ bridgeEveryMs: 4000 }, ['localized'], { masterMs: 700 })
    const run = runAlohaSetup(t.ctx)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(t.step('bridge')).toMatchObject({ status: 'active', detail: expect.stringMatching(/^Bridging \d+ of 28 topics: the ALOHA answers slowly \(0\.7 s a call to its ROS master\)$/) })
    await finish(run)
    expect(t.step('bridge').status).toBe('done')
    expect(t.step('bridge').detail).toBe('ROS_DOMAIN_ID=1 · /scan at 10.0 Hz · the ALOHA answers slowly (0.7 s a call to its ROS master)')
    expect(YAML_TOPICS).toHaveLength(28)
  })

  it('gives up on a bridge that stops bridging, saying where it stopped', async () => {
    const t = setUp({ bridgeStallsAfter: 10 })
    await expect(finish(runAlohaSetup(t.ctx))).rejects.toThrow(
      `aloha/bridge.sh bridged nothing more for 30 s, after 10 of 28 topics (the last: ${YAML_TOPICS[9]})`,
    )
    expect(t.step('bridge').checks.map((c) => [c.label, c.ok])).toEqual([
      ['/scan', true],
      ['/map', true],
      ['/move_base/status', true],
      ['/puppet/joint_left', null],
      ['/aloha/dock/result', null],
    ])
  })

  it('keeps a bridge already running on ROS_DOMAIN_ID=1', async () => {
    const t = setUp({}, ['localized'], { bridged: true })
    await finish(runAlohaSetup(t.ctx))
    expect(t.laptop.typed).toEqual([])
    expect(t.relay.state).toBe('kept')
  })

  it('detaches from tmux, never Ctrl+C, when it runs again', async () => {
    const t = setUp({}, ['localized'])
    await finish(runAlohaSetup(t.ctx))
    const again = setUp({ running: true }, ['keep-aloha', 'localized'])
    // The same terminals, still in tmux
    const ctx = { ...again.ctx, robotShell: () => t.robot, laptopShell: () => t.laptop }
    t.aloha.running = true
    await finish(runAlohaSetup(ctx))
    expect(t.robot.typed.slice(2)).toEqual(['exit', `ssh agilex@${IP}`, 'bash start_aloha.sh'])
    expect(t.robot.textSince(0)).not.toContain('^C')
  })
})

describe('localizing the ALOHA', () => {
  it('shows the operator’s 2D Pose Estimate and where AMCL then has it, while it waits for the operator', async () => {
    const t = setUp({}, [], { bridged: true })
    const run = runAlohaSetup(t.ctx)
    run.catch(() => undefined)
    for (let i = 0; i < 1200 && !t.asked.some((p) => p.kind === 'localize'); i++) await vi.advanceTimersByTimeAsync(100)
    expect(t.asked.at(-1)).toEqual({ kind: 'localize', rviz: 'running', pose: null, amcl: null })
    t.estimates.forEach((on) => on({ x: 1.2, y: 5.1, yaw: 88, at: 1 }))
    t.amclPoses.forEach((on) => on({ x: 1.25, y: 5.05, yaw: 90, at: 2 }))
    expect(t.updated.at(-1)).toEqual({ kind: 'localize', rviz: 'running', pose: { x: 1.2, y: 5.1, yaw: 88, at: 1 }, amcl: { x: 1.25, y: 5.05, yaw: 90, at: 2 } })
    t.abort.abort()
    await expect(finish(run)).rejects.toThrow()
    // its watchers end with the step
    expect(t.estimates).toHaveLength(0)
    expect(t.amclPoses).toHaveLength(0)
  })

  it('says where AMCL has the ALOHA once it is confirmed', async () => {
    const t = setUp({}, [], { bridged: true })
    t.ctx.ask = (key, prompt) => {
      t.asked.push(prompt)
      if (key !== 'localize') return Promise.reject(new Error(`unexpected ${key}`))
      t.amclPoses.forEach((on) => on({ x: 1.254, y: 5.049, yaw: 89.6, at: 3 }))
      return Promise.resolve('localized')
    }
    await finish(runAlohaSetup(t.ctx))
    expect(t.step('localize')).toMatchObject({ status: 'done', detail: 'Localized at x 1.25, y 5.05, heading 90° (AMCL)' })
    expect(t.step('localize').commands.at(-1)).toMatchObject({ status: 'done', note: 'open' })
  })
})

describe('reading the ALOHA', () => {
  it('reads what parameter_bridge got through, from its own lines', () => {
    const out = [
      "Trying to create bidirectional bridge for topic '/tf' with ROS 2 type 'tf2_msgs/msg/TFMessage'",
      '[INFO] [1795166125.86] [ros_bridge]: create bidirectional bridge for topic /tf',
      "failed to create bidirectional bridge for topic '/puppet/arm_status_left' with ROS 2 type 'piper_msgs/msg/PiperStatusMsg': No template specialization for the pair",
    ].join('\n')
    expect(bridgeProgress(out)).toEqual({ created: ['/tf'], failed: ['/puppet/arm_status_left'], settled: false })
    expect(bridgeProgress(`${out}\nThe parameter 'services_1_to_2' either doesn't exist or isn't an array`).settled).toBe(true)
    expect(YAML_TOPICS.slice(0, 3)).toEqual(['/tf', '/tf_static', '/map'])
    expect(YAML_TOPICS.at(-1)).toBe('/aloha/dock/result')
  })

  it('knows when the terminal shows start_aloha.sh’s tmux', () => {
    expect(tmuxAttached(`agilex@agilex:~$ bash start_aloha.sh\n[aloha] 0:roscore* 1:cameras-`)).toBe(true)
    expect(tmuxAttached(`[aloha] 0:roscore* 1:cameras-\n[detached (from session aloha)]\nagilex@agilex:~$ `)).toBe(false)
    expect(tmuxAttached('agilex@agilex:~$ ')).toBe(false)
  })

  it('names anonymous nodes without their suffix', () => {
    expect(shortNode('/piper_left_agilex_26509_5913675078893375078')).toBe('/piper_left')
    expect(shortNode('/rf2o_laser_odometry')).toBe('/rf2o_laser_odometry')
  })

  it('names who publishes each part, or what is missing', () => {
    const checks = stackChecks(master(['Cameras']))
    expect(checks[0]).toEqual({ label: 'roscore', ok: true, value: '/roscore_node' })
    expect(checks[1]).toEqual({ label: 'Cameras', ok: false, value: 'no /camera_f/color/image_raw/compressed (+2)' })
    expect(stackChecks(null)[0]).toEqual({ label: 'roscore', ok: false, value: 'no answer' })
  })
})
