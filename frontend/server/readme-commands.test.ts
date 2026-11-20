import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { M20_STEPS, scriptOf } from './m20-setup.ts'
import { ALOHA, README, RELAY_NODE_COUNT, recordWaypoints, relayedTopics } from './readme-commands.ts'

/* The setup types the README's commands as written: if README.md or relays.launch.py change, these say what to update */

const robot = { id: '741', ip: '192.168.123.100', user: 'user' }
const readmeLines = readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
  .replaceAll('<robot_id>', robot.id)
  .replaceAll('<robot_ip>', robot.ip)
  .split('\n')
  // A command line, without its trailing comment
  .map((line) => line.split(/\s+#\s/)[0].trim())

describe('the commands the setup types', () => {
  // rviz2 gets -d <the robot's config> in front of the README's own arguments
  const typed = M20_STEPS.flatMap((key) => scriptOf(key, robot).map((c) => c.text.replace(/^rviz2 -d \S+ /, 'rviz2 ')))

  it.each(typed)('appear verbatim in README.md: %s', (text) => {
    expect(readmeLines).toContain(text)
  })

  it('type the robot side Step 3 in the README’s order', () => {
    const lines = scriptOf('relay', robot).map((c) => readmeLines.indexOf(c.text))
    expect(lines).toEqual([...lines].sort((a, b) => a - b))
  })

  it('open RViz on the robot’s own config, with the README’s arguments after it', () => {
    const [rviz] = scriptOf('localize', robot)
    expect(rviz.text).toBe(
      'rviz2 -d frontend/server/rviz/robot_741.rviz --ros-args -r /tf:=/tf_relayed -r /tf_static:=/tf_static_relayed -r /goal_pose:=/goal_pose_741 -r /initialpose:=/initialpose_relayed_741',
    )
  })

  it('show the registry fix as the README writes it', () => {
    expect(readmeLines).toContain(README.daemonJson)
    expect(readmeLines).toContain(README.restartDocker)
  })
})

describe('the topics the check expects', () => {
  const launch = readFileSync(new URL('../../launch/relays.launch.py', import.meta.url), 'utf8')
  const relays = [...launch.matchAll(/^\s*\('(\w+)',\s*'(\w+)',\s*'([^']+)',\s*'([^']+)'/gm)]

  it('are one node per entry of relays.launch.py’s RELAYS', () => {
    expect(relays).toHaveLength(RELAY_NODE_COUNT)
  })

  it('are the _relayed topics relays.launch.py makes, suffixed with the robot ID except the shared TF', () => {
    const { own, shared } = relayedTopics(robot.id)
    const made = relays.flatMap((m) => [m[3], m[4]]).filter((t) => t.endsWith('_relayed'))
    expect(shared.every((t) => made.includes(t))).toBe(true)
    expect([...own].sort()).toEqual(
      made
        .filter((t) => !shared.includes(t))
        .map((t) => `${t}_${robot.id}`)
        .sort(),
    )
  })
})

describe('the ALOHA’s commands', () => {
  const script = readFileSync(new URL('../../aloha/robot/start_aloha.sh', import.meta.url), 'utf8')
  // Its usage lines: "#   bash start_aloha.sh       start them all and attach"
  const usage = [...script.matchAll(/^#\s+(bash start_aloha\.sh(?: stop)?)\s{2,}/gm)].map((m) => m[1])

  it('start and stop it as start_aloha.sh’s usage lines write them', () => {
    expect(usage).toContain(ALOHA.start)
    expect(usage).toContain(ALOHA.stop)
  })

  it('bridge it with the script the demo uses', () => {
    expect(readFileSync(new URL('../../demo/run_demo.sh', import.meta.url), 'utf8')).toContain('aloha/run_aloha.sh')
    expect(readFileSync(new URL(`../../${ALOHA.bridge}`, import.meta.url), 'utf8')).toMatch(/parameter_bridge/)
  })
})

describe('the recorder’s command', () => {
  it('is the README’s, with the session’s plan folder as WAYPOINTS', () => {
    const typed = [recordWaypoints('patrol', '665', 'demo/waypoints/x', false), recordWaypoints('sweep', '738', 'demo/waypoints/x', true)]
    for (const line of typed) expect(readmeLines).toContain(line.replace(' WAYPOINTS=demo/waypoints/x', ''))
  })
})
