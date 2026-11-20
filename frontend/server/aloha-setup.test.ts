import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptChoice, RelayState, SetupPrompt } from '../src/shared/api/setup-protocol.ts'
import { ALOHA_STACK, ALOHA_STEPS, pendingAlohaStep, runAlohaSetup, shortNode, stackChecks, tmuxAttached, type AlohaSetupContext } from './aloha-setup.ts'
import type { SystemState } from './ros1-master.ts'
import { Aborted, ShellTranscript, type Shell } from './shell-transcript.ts'

/* The ALOHA's setup against a scripted ALOHA: its ssh, start_aloha.sh and tmux, its ROS master, and the laptop's bridge */

const IP = '192.168.123.200'
const ROBOT = { id: 'aloha', ip: IP, user: 'agilex' }
const TMUX_DRAW =
  '\x1b[?1049h\x1b[H\x1b[2J\x1b[?25l\x1b[1;1Hroscore\r\n\x1b[40;1H\x1b[30m\x1b[42m[aloha] 0:roscore* 1:cameras- 2:arms  3:lidar  4:base  5:navigation  6:stream  7:dock\x1b[0m'

interface AlohaScript {
  password: string
  /** start_aloha.sh's tmux session is already there */
  running: boolean
}

class ScriptedAloha extends ShellTranscript implements Shell {
  readonly typed: string[] = []
  place: 'laptop' | 'aloha' | 'tmux' = 'laptop'
  private awaiting = false
  private foreground: 'bridge' | null = null
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
      return this.later(
        () =>
          this.append(
            "Trying to create bidirectional bridge for topic '/scan' with ROS 2 type 'sensor_msgs/msg/LaserScan'\r\n[INFO] [1795160540.1] [ros_bridge]: create bidirectional bridge for topic /scan\r\n",
          ),
        200,
      )
    }
    if (line === 'exit' && this.place === 'aloha') {
      this.place = 'laptop'
      return done(`logout\r\nConnection to ${IP} closed.\r\n`)
    }
    if (line.startsWith('export ')) return done()
    return done(`bash: ${line.split(' ')[0]}: command not found\r\n`)
  }
}

/** Every part's topics published, but those in `without` */
function master(without: string[] = []): SystemState {
  const publishers = new Map<string, string[]>()
  for (const part of ALOHA_STACK) if (!without.includes(part.label)) for (const topic of part.topics) publishers.set(topic, [`/${part.window}_node`])
  return { publishers, subscribers: new Map() }
}

function setUp(script: Partial<AlohaScript> = {}, answers: PromptChoice[] = [], options: { down?: string[]; bridged?: boolean } = {}) {
  const aloha: AlohaScript = { password: 'agx', running: false, ...script }
  const robot = new ScriptedAloha(aloha)
  const laptop = new ScriptedAloha(aloha)
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
      if (!aloha.running) throw new Error('connect ECONNREFUSED')
      return master(options.down)
    },
    domainTopics: async () => (bridging ? ['/scan', '/map', '/move_base/status', '/puppet/joint_left', '/aloha/dock/result', '/rosout'] : ['/rosout']),
    topicRate: async () => 10.04,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
  return { ctx, robot, laptop, steps, asked, relay, abort, step: ctx.step, aloha }
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
  it('logs in as agilex, runs start_aloha.sh, checks its stack, then bridges it here', async () => {
    const t = setUp()
    await finish(runAlohaSetup(t.ctx))
    expect(t.robot.typed).toEqual([`ssh agilex@${IP}`, 'bash start_aloha.sh'])
    expect(t.laptop.typed).toEqual(['export FASTRTPS_DEFAULT_PROFILES_FILE=fastdds_profile.xml', 'aloha/bridge.sh'])
    expect(t.steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done'])
    expect(t.step('stack').checks.map((c) => [c.label, c.ok])).toEqual(ALOHA_STACK.map((p) => [p.label, true]))
    expect(t.step('bridge').checks.find((c) => c.label === '/scan rate')).toEqual({ label: '/scan rate', ok: true, value: '10.0 Hz' })
    expect(t.relay).toEqual({ state: 'running', rate: 10.04 })
    // The robot terminal stays in start_aloha.sh's tmux, as by hand
    expect(t.robot.place).toBe('tmux')
  })

  it('keeps a session already running, without starting a second one', async () => {
    const t = setUp({ running: true }, ['keep-aloha'])
    await finish(runAlohaSetup(t.ctx))
    expect(t.asked).toEqual([{ kind: 'aloha-running' }])
    expect(t.robot.typed.filter((l) => l === 'bash start_aloha.sh')).toHaveLength(1)
    expect(t.step('start').commands.map((c) => c.status)).toEqual(['skipped'])
    expect(t.steps.every((s) => s.status === 'done')).toBe(true)
  })

  it('restarts a session already running when asked: stop, then start', async () => {
    const t = setUp({ running: true }, ['restart-aloha'])
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

  it('keeps a bridge already running on ROS_DOMAIN_ID=1', async () => {
    const t = setUp({}, [], { bridged: true })
    await finish(runAlohaSetup(t.ctx))
    expect(t.laptop.typed).toEqual([])
    expect(t.relay.state).toBe('kept')
  })

  it('detaches from tmux, never Ctrl+C, when it runs again', async () => {
    const t = setUp()
    await finish(runAlohaSetup(t.ctx))
    const again = setUp({ running: true }, ['keep-aloha'])
    // The same terminals, still in tmux
    const ctx = { ...again.ctx, robotShell: () => t.robot, laptopShell: () => t.laptop }
    t.aloha.running = true
    await finish(runAlohaSetup(ctx))
    expect(t.robot.typed.slice(2)).toEqual(['exit', `ssh agilex@${IP}`, 'bash start_aloha.sh'])
    expect(t.robot.textSince(0)).not.toContain('^C')
  })
})

describe('reading the ALOHA', () => {
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
