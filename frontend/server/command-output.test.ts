import { describe, expect, it } from 'vitest'
import {
  afterEcho,
  echoedMessages,
  echoedPose,
  errorLine,
  hzRates,
  publisherCount,
  pullOutcome,
  relayLaunch,
  topicsListed,
} from './command-output.ts'

/* Real output of the README's commands, as plain text (no colours, no carriage returns) */

describe('docker pull', () => {
  it('is up to date', () => {
    const out = `foxy: Pulling from m20-bridge
Digest: sha256:${'ab'.repeat(32)}
Status: Image is up to date for 192.168.123.160:5000/m20-bridge:foxy
192.168.123.160:5000/m20-bridge:foxy
`
    expect(pullOutcome(out)).toEqual({ ok: true, updated: false, digest: `sha256:${'ab'.repeat(32)}` })
  })

  it('pulled a newer image', () => {
    const out = `foxy: Pulling from m20-bridge
3c645031de29: Already exists
e1b4f9e5c4a1: Pull complete
Digest: sha256:${'cd'.repeat(32)}
Status: Downloaded newer image for 192.168.123.160:5000/m20-bridge:foxy
`
    expect(pullOutcome(out)).toMatchObject({ ok: true, updated: true })
  })

  it('needs the registry trusted (README: insecure-registries)', () => {
    const out = 'Error response from daemon: Get "https://192.168.123.160:5000/v2/": http: server gave HTTP response to HTTPS client\n'
    expect(pullOutcome(out)).toEqual({ ok: false, insecureRegistry: true, error: out.trim() })
  })

  it('cannot reach the registry', () => {
    const out = 'Error response from daemon: Get "http://192.168.123.160:5000/v2/": dial tcp 192.168.123.160:5000: connect: connection refused\n'
    expect(pullOutcome(out)).toMatchObject({ ok: false, insecureRegistry: false })
  })
})

describe('errors of the other commands', () => {
  it.each([
    ['docker compose up -d nav_cmd_bridge', 'no configuration file provided: not found\n'],
    ['docker compose up -d nav_cmd_bridge', 'no such service: nav_cmd_bridge\n'],
    ['docker tag', 'Error response from daemon: No such image: 192.168.123.160:5000/m20-bridge:foxy\n'],
    ['docker compose exec', 'service "nav_cmd_bridge" is not running\n'],
    ['source install/setup.bash', 'bash: install/setup.bash: No such file or directory\n'],
    ['docker compose', "docker: 'compose' is not a docker command.\n"],
  ])('%s: %s', (_, out) => {
    expect(errorLine(out)).toBe(out.trim())
  })

  it('none in a working docker compose up', () => {
    expect(errorLine('[+] Running 1/1\n ✔ Container user-nav_cmd_bridge-1  Started\n')).toBeNull()
  })

  it('skip the echoed command line', () => {
    expect(afterEcho('docker tag  a b\nroot@host:~# ')).toBe('root@host:~# ')
  })
})

describe('ros2 launch nav_cmd_bridge relays.launch.py', () => {
  const started = Array.from({ length: 7 }, (_, i) => `[INFO] [relay-${i + 1}]: process started with pid [${100 + i}]`).join('\n')

  it('counts the relays started', () => {
    const out = `[INFO] [launch]: All log files can be found below /root/.ros/log/x\n${started}\n`
    expect(relayLaunch(out)).toEqual({ started: 7, died: null, fatal: null })
  })

  it('sees a relay die', () => {
    const out = `${started}\n[ERROR] [odom_relay-3]: process has died [pid 102, exit code 1, cmd 'odom_relay'].\n`
    expect(relayLaunch(out).died).toBe("[ERROR] [odom_relay-3]: process has died [pid 102, exit code 1, cmd 'odom_relay'].")
  })

  it('sees the package missing', () => {
    expect(relayLaunch("Package 'nav_cmd_bridge' not found: \"package 'nav_cmd_bridge' not found\"\n").fatal).toMatch(/^Package/)
  })
})

describe('ros2 topic', () => {
  it('list: the topics only', () => {
    expect(topicsListed('/ODOM_relayed_741\n/parameter_events\n/rosout\n/tf_relayed\nroot@host:~# ')).toEqual([
      '/ODOM_relayed_741',
      '/parameter_events',
      '/rosout',
      '/tf_relayed',
    ])
  })

  it('hz: every average rate', () => {
    const out = 'average rate: 9.998\n\tmin: 0.096s max: 0.104s std dev: 0.00213s window: 11\naverage rate: 10.001\n'
    expect(hzRates(out)).toEqual([9.998, 10.001])
  })

  it('info: the publisher count; an unknown topic has none', () => {
    expect(publisherCount('Type: nav_msgs/msg/Odometry\nPublisher count: 1\nSubscription count: 0\n')).toBe(1)
    expect(publisherCount("Unknown topic '/ODOM_relayed_741'\n")).toBe(0)
    expect(publisherCount('')).toBeNull()
  })

  it('echo: the 2D Pose Estimate, heading in degrees', () => {
    const message = `header:
  stamp:
    sec: 1763611200
    nanosec: 0
  frame_id: map
pose:
  pose:
    position:
      x: 1.25
      y: -0.5
      z: 0.0
    orientation:
      x: 0.0
      y: 0.0
      z: 0.7071068
      w: 0.7071068
  covariance:
  - 0.25
`
    const { messages, rest } = echoedMessages(`${message}---\n${message.slice(0, 40)}`)
    expect(messages).toHaveLength(1)
    expect(rest).toBe(message.slice(0, 40))
    const pose = echoedPose(messages[0])!
    expect(pose.x).toBe(1.25)
    expect(pose.y).toBe(-0.5)
    expect(pose.yaw).toBeCloseTo(90, 3)
  })
})
