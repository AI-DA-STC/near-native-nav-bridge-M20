import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptChoice, RelayState, SetupPrompt } from '../src/shared/api/setup-protocol.ts'
import { M20_STEPS, pendingStep, runM20Setup, type M20SetupContext } from './m20-setup.ts'
import { README, RECOVERY } from './readme-commands.ts'
import { Aborted, ShellTranscript, type Shell } from './shell-transcript.ts'

/* The setup against a scripted robot: two terminals that answer like this workstation's bash, the robot's ssh, su,
 * docker and its container, and the laptop's ros2 */

const IP = '192.168.123.100'
const ROBOT = { id: '741', ip: IP, user: 'user' }
const UP_TO_DATE = `foxy: Pulling from m20-bridge\r\nDigest: sha256:${'a'.repeat(64)}\r\nStatus: Image is up to date for 192.168.123.160:5000/m20-bridge:foxy\r\n192.168.123.160:5000/m20-bridge:foxy\r\n`
const INSECURE = 'Error response from daemon: Get "https://192.168.123.160:5000/v2/": http: server gave HTTP response to HTTPS client\r\n'
const TOPICS = ['/ALIGNED_POINTS_relayed_741', '/GRID_MAP_relayed_741', '/ODOM_relayed_741', '/goal_pose_relayed_741', '/initialpose_relayed_741', '/parameter_events', '/rosout', '/tf_relayed', '/tf_static_relayed']

type Place = 'laptop' | 'robot-user' | 'robot-root' | 'container'

interface RobotScript {
  /** What the robot accepts */
  password: string
  /** The output of each docker pull in turn; up to date once they run out */
  pulls: string[]
  /** Publishers on /ODOM_relayed_741 before the launch */
  publishers: number
}

class ScriptedTerminal extends ShellTranscript implements Shell {
  readonly typed: string[] = []
  place: Place = 'laptop'
  private awaiting: 'ssh' | 'su' | null = null
  private foreground: 'launch' | 'hz' | 'rviz' | null = null
  private timers: Array<ReturnType<typeof setTimeout>> = []
  private readonly script: RobotScript

  constructor(script: RobotScript) {
    super()
    this.script = script
    this.later(() => this.print(this.prompt()))
  }

  private prompt(): string {
    return {
      laptop: 'root@workstation:~/ros2_ws/src/nav_cmd_bridge# ',
      'robot-user': 'user@host.v1.4:~$ ',
      'robot-root': 'root@host.v1.4:/home/user# ',
      container: 'root@host.v1.4:~/ros2_ws# ',
    }[this.place]
  }

  private print(text: string) {
    this.append(text)
  }

  private later(fn: () => void, ms = 0) {
    this.timers.push(setTimeout(fn, ms))
  }

  write(data: string): void {
    if (data === '\x03') return this.interrupt()
    const line = data.replace(/\r$/, '')
    if (this.awaiting) return this.password(line)
    if (this.foreground) return
    this.typed.push(line)
    this.print(`${line}\r\n`)
    this.later(() => this.run(line))
  }

  private password(line: string) {
    const which = this.awaiting
    this.awaiting = null
    this.print('\r\n')
    if (line !== this.script.password) {
      if (which === 'ssh') {
        this.awaiting = 'ssh'
        return this.print(`Permission denied, please try again.\r\nuser@${IP}'s password: `)
      }
      return this.print(`su: Authentication failure\r\n${this.prompt()}`)
    }
    if (which === 'ssh') {
      this.place = 'robot-user'
      this.print('Web console: https://host.v1.4:9393/\r\n\r\nLast login: Wed Jun 19 03:52:03 2024 from 192.168.123.160\r\n')
    } else this.place = 'robot-root'
    this.print(this.prompt())
  }

  private run(line: string) {
    const done = (output = '') => this.print(output + this.prompt())
    const at = this.place
    if (line === `ssh user@${IP}` && at === 'laptop') {
      this.awaiting = 'ssh'
      return this.print(`user@${IP}'s password: `)
    }
    if (line === 'su' && at === 'robot-user') {
      this.awaiting = 'su'
      return this.print('Password: ')
    }
    if (line === README.pull && at === 'robot-root') return done(this.script.pulls.shift() ?? UP_TO_DATE)
    if (line === README.tag && at === 'robot-root') return done()
    if ((line === README.composeUp || line === RECOVERY.restartContainer) && at === 'robot-root') {
      return done('[+] Running 1/1\r\n \x1b[32m✔\x1b[0m Container user-nav_cmd_bridge-1  \x1b[32mStarted\x1b[0m\r\n')
    }
    if (line === README.composeExec && at === 'robot-root') {
      this.place = 'container'
      return done()
    }
    if (line === README.launchRelays && at === 'container') {
      this.foreground = 'launch'
      this.print('[INFO] [launch]: All log files can be found below /root/.ros/log/2026-11-20-04-00-00-host-1\r\n')
      for (let i = 1; i <= 7; i++) this.later(() => this.print(`[INFO] [relay-${i}]: process started with pid [${100 + i}]\r\n`), 150 * i)
      return
    }
    if (line === README.topicList && at === 'laptop') return done(`${TOPICS.join('\r\n')}\r\n`)
    if (line === README.topicHz('741') && at === 'laptop') {
      this.foreground = 'hz'
      for (let i = 1; i <= 5; i++) this.later(() => this.print(`average rate: 10.0${i}\r\n\tmin: 0.098s max: 0.102s std dev: 0.001s window: ${10 * i}\r\n`), 1000 * i)
      return
    }
    if (line.startsWith('rviz2 -d ') && line.endsWith(README.rviz('741').slice('rviz2 '.length)) && at === 'laptop') {
      this.foreground = 'rviz'
      return this.print('[INFO] [1763611200.000000000] [rviz2]: Stereo is NOT SUPPORTED\r\n')
    }
    if (line === 'exit') return this.exit()
    if (line.startsWith('export ') || line.startsWith('source ')) return done()
    return done(`bash: ${line.split(' ')[0]}: command not found\r\n`)
  }

  private interrupt() {
    this.print('^C')
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
    if (this.foreground === 'launch') this.print('\r\n[WARNING] [launch]: user interrupted with ctrl-c (SIGINT)')
    // ros2 topic hz ends quietly: bash prints its prompt right after the echoed ^C, as on the real laptop
    const quiet = this.foreground === 'hz'
    this.foreground = null
    this.awaiting = null
    this.print(quiet ? this.prompt() : `\r\n${this.prompt()}`)
  }

  private exit() {
    if (this.place === 'container') this.place = 'robot-root'
    else if (this.place === 'robot-root') this.place = 'robot-user'
    else if (this.place === 'robot-user') {
      this.place = 'laptop'
      this.print(`logout\r\nConnection to ${IP} closed.\r\n`)
    }
    this.print(this.prompt())
  }
}

function setUp(script: Partial<RobotScript> = {}, answers: PromptChoice[] = [], typedPassword = "'") {
  const robotScript: RobotScript = { password: "'", pulls: [], publishers: 0, ...script }
  // The robot's password as saved: an answer to the password prompt replaces it
  let saved = typedPassword
  const robot = new ScriptedTerminal(robotScript)
  const laptop = new ScriptedTerminal(robotScript)
  const steps = M20_STEPS.map((key) => pendingStep(key, ROBOT))
  const asked: SetupPrompt[] = []
  const relay: { state: RelayState; rate: number | null } = { state: 'none', rate: null }
  const abort = new AbortController()
  const ctx: M20SetupContext = {
    robot: ROBOT,
    password: () => saved,
    laptopHost: 'workstation',
    signal: abort.signal,
    robotShell: () => robot,
    laptopShell: () => laptop,
    step: (key) => steps.find((s) => s.key === key)!,
    changed: () => undefined,
    ask: (key, prompt) => {
      asked.push(prompt)
      const step = ctx.step(key)
      step.status = 'decision'
      step.prompt = prompt
      const choice = answers.shift()
      // The operator answers half a second later, or never; a new password goes with retry-login
      return new Promise((resolve, reject) => {
        abort.signal.addEventListener('abort', () => reject(new Aborted()))
        if (choice)
          setTimeout(() => {
            step.status = 'active'
            step.prompt = null
            if (choice === 'retry-login') saved = robotScript.password
            resolve(choice)
          }, 500)
      })
    },
    updatePrompt: (key, prompt) => {
      ctx.step(key).prompt = prompt
    },
    setActivity: () => undefined,
    setRelay: (state, rate) => {
      relay.state = state
      if (rate !== undefined) relay.rate = rate
    },
    relayLaunched: () => undefined,
    odomPublishers: async () => robotScript.publishers,
    writeRvizConfig: () => undefined,
    watchInitialPose: (onPose) => {
      const timer = setTimeout(() => onPose({ x: 1.25, y: -0.5, yaw: 90, at: Date.now() }), 100)
      return () => clearTimeout(timer)
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
  return { ctx, robot, laptop, steps, asked, relay, abort, step: ctx.step }
}

/** Runs fake time forward until the promise settles */
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

describe('an M20’s setup', () => {
  it('types the README’s commands in order, into the robot and laptop terminals', async () => {
    const t = setUp({}, ['localized'])
    await finish(runM20Setup(t.ctx))
    expect(t.robot.typed).toEqual([
      `ssh user@${IP}`,
      'su',
      'docker pull --platform linux/arm64 192.168.123.160:5000/m20-bridge:foxy',
      'docker tag  192.168.123.160:5000/m20-bridge:foxy m20-bridge:foxy',
      'docker compose up -d nav_cmd_bridge',
      'docker compose exec nav_cmd_bridge bash',
      'export ROBOT_ID=741',
      'export ROS_DOMAIN_ID=0',
      'ros2 launch nav_cmd_bridge relays.launch.py',
    ])
    expect(t.laptop.typed).toEqual([
      'export ROS_DOMAIN_ID=0',
      'export FASTRTPS_DEFAULT_PROFILES_FILE=fastdds_profile.xml',
      'source install/setup.bash',
      'ros2 topic list',
      'ros2 topic hz /ODOM_relayed_741',
      'rviz2 -d frontend/server/rviz/robot_741.rviz --ros-args -r /tf:=/tf_relayed -r /tf_static:=/tf_static_relayed -r /goal_pose:=/goal_pose_741 -r /initialpose:=/initialpose_relayed_741',
    ])
    expect(t.steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'done'])
    expect(t.steps.flatMap((s) => s.commands.map((c) => c.status))).not.toContain('pending')
    expect(t.robot.place).toBe('container')
    expect(t.relay).toEqual({ state: 'running', rate: 10.02 })
  })

  it('reports what each step found', async () => {
    const t = setUp({}, ['localized'])
    await finish(runM20Setup(t.ctx))
    expect(t.step('login').commands.map((c) => c.note)).toEqual(['user@host.v1.4', 'root@host.v1.4'])
    expect(t.step('image').detail).toBe('Image up to date, tagged m20-bridge:foxy')
    expect(t.step('relay').commands.at(-1)!.note).toBe('7 of 7 relays started')
    expect(t.step('topics').checks.every((c) => c.ok)).toBe(true)
    expect(t.step('topics').checks.at(-1)).toEqual({ label: '/ODOM_relayed_741 rate', ok: true, value: '10.0 Hz' })
    expect(t.step('localize').detail).toBe('Localized at x 1.25, y -0.50, heading 90°')
  })

  it('asks for the registry to be trusted, then pulls again', async () => {
    const t = setUp({ pulls: [INSECURE] }, ['retry', 'localized'])
    await finish(runM20Setup(t.ctx))
    expect(t.asked[0]).toEqual({ kind: 'registry', registry: '192.168.123.160:5000', error: INSECURE.trim() })
    expect(t.robot.typed.filter((line) => line === README.pull)).toHaveLength(2)
    expect(t.step('image').status).toBe('done')
  })

  it('keeps a relay that already runs, without launching a second one', async () => {
    const t = setUp({ publishers: 1 }, ['keep-relay', 'localized'])
    await finish(runM20Setup(t.ctx))
    expect(t.asked[0]).toEqual({ kind: 'relay-running', topic: '/ODOM_relayed_741', publishers: 1 })
    expect(t.robot.typed).not.toContain(README.launchRelays)
    expect(t.step('relay').commands.map((c) => c.status)).toEqual(['done', 'skipped', 'skipped', 'skipped', 'skipped'])
    expect(t.relay.state).toBe('running')
  })

  it('restarts the container when asked, then launches', async () => {
    const t = setUp({ publishers: 2 }, ['restart-container', 'localized'])
    await finish(runM20Setup(t.ctx))
    const typed = t.robot.typed
    expect(typed.indexOf(RECOVERY.restartContainer)).toBeGreaterThan(typed.indexOf(README.composeUp))
    expect(typed.indexOf(README.launchRelays)).toBeGreaterThan(typed.indexOf(RECOVERY.restartContainer))
  })

  it('asks for the password when the robot refuses it, typing each one once, then logs in with the new one', async () => {
    const t = setUp({ password: 'right' }, ['retry-login', 'localized'], 'wrong')
    await finish(runM20Setup(t.ctx))
    expect(t.asked[0]).toEqual({ kind: 'password', login: `user@${IP}`, error: `The robot refused the password for user@${IP}` })
    expect(t.robot.typed.filter((line) => line === `ssh user@${IP}`)).toHaveLength(2)
    expect(t.step('login').status).toBe('done')
    expect(t.steps.every((s) => s.status === 'done')).toBe(true)
  })

  it('stops at the password prompt when the operator stops, back on this workstation', async () => {
    const t = setUp({ password: 'right' }, ['stop'], 'wrong')
    await expect(finish(runM20Setup(t.ctx))).rejects.toBeInstanceOf(Aborted)
    expect(t.step('login').status).toBe('stopped')
    expect(t.step('image').status).toBe('pending')
    expect(t.robot.place).toBe('laptop')
  })

  it('stops where the operator stops it', async () => {
    const t = setUp()
    const run = runM20Setup(t.ctx)
    for (let i = 0; i < 300 && t.step('localize').status !== 'decision'; i++) await vi.advanceTimersByTimeAsync(100)
    expect(t.step('localize').prompt).toMatchObject({ kind: 'localize', rviz: 'running' })
    t.abort.abort()
    await expect(finish(run)).rejects.toBeInstanceOf(Aborted)
    expect(t.step('localize').status).toBe('stopped')
    expect(t.step('topics').status).toBe('done')
  })

  it('resumes from a stopped pull with the robot terminal where it was left', async () => {
    const first = setUp({ pulls: ['Error response from daemon: manifest unknown\r\n'] }, ['stop'])
    await expect(finish(runM20Setup(first.ctx))).rejects.toBeInstanceOf(Aborted)
    expect(first.asked[0]).toMatchObject({ kind: 'pull-failed' })
    expect(first.step('image').status).toBe('stopped')
    const typedBefore = first.robot.typed.length
    const answers: PromptChoice[] = ['localized']
    first.ctx.ask = (_key, prompt) => {
      first.asked.push(prompt)
      return new Promise((resolve) => setTimeout(() => resolve(answers.shift()!), 500))
    }
    const again = new AbortController()
    await finish(runM20Setup({ ...first.ctx, signal: again.signal }, 'image'))
    expect(first.robot.typed.slice(typedBefore, typedBefore + 2)).toEqual([README.pull, README.tag])
    expect(first.steps.every((s) => s.status === 'done')).toBe(true)
  })
})
