import type { RobotSetupFacts, RobotSuggestion, SetupSnapshot } from '@/shared/api'
import { FLEET, ROBOT_KEYS, type RobotKey } from '@/shared/config'
import { formatTimeOfDay, type Tone } from '@/shared/lib'
import { STEP_INFO, currentStep, promptAsk } from './setup-steps'

/* The lobby: one slot per robot in the order it joined, then the slot that adds the next one. A robot's model shows
 * whole when it answers on the network and faded when it does not; the words under it say where its setup is. */

/** The lobby always shows this many slots, as a game lobby shows its empty seats */
export const MIN_SLOTS = 4

export type Slot =
  | { kind: 'robot'; robot: RobotSetupFacts }
  /** The next README robot not added yet, if any */
  | { kind: 'add'; next: RobotSuggestion | null }
  | { kind: 'empty' }

export function slotsOf(snapshot: SetupSnapshot): Slot[] {
  const slots: Slot[] = snapshot.robots.map((robot) => ({ kind: 'robot', robot }))
  slots.push({ kind: 'add', next: nextSuggestion(snapshot.suggestions) })
  while (slots.length < MIN_SLOTS) slots.push({ kind: 'empty' })
  return slots
}

/** The README robot to suggest next: an online one first, in the README's order */
export function nextSuggestion(suggestions: readonly RobotSuggestion[]): RobotSuggestion | null {
  return suggestions.find((s) => s.presence === 'online') ?? suggestions[0] ?? null
}

/** Which demo robot this is (741 is R1), for its identity colour and tag; null for a robot the demo does not know */
export function identityOf(robot: { kind: RobotSetupFacts['kind']; id: string }): RobotKey | null {
  if (robot.kind === 'aloha') return 'aloha'
  return ROBOT_KEYS.find((key) => FLEET[key].kind === 'dog' && FLEET[key].id === robot.id) ?? null
}

/** The big name under the model: the ID, or ALOHA */
export function nameOf(robot: { kind: RobotSetupFacts['kind']; id: string }): string {
  return robot.kind === 'aloha' ? 'ALOHA' : robot.id
}

export const KIND_LABEL = { m20: 'M20', aloha: 'Mobile ALOHA' } as const

export interface SlotStatus {
  /** In capitals, readable from across the room */
  word: string
  tone: Tone
  /** One line under the word */
  detail: string
  /** The model fades while the robot does not answer */
  presence: 'online' | 'offline' | 'checking'
  /** Something is going on now */
  pulse: boolean
}

/** When a past moment was: "10:42:07" today, "19 Nov 10:42" before */
export function whenOf(epochMs: number, now: number): string {
  const d = new Date(epochMs)
  if (new Date(now).toDateString() === d.toDateString()) return formatTimeOfDay(epochMs)
  return `${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })} ${formatTimeOfDay(epochMs).slice(0, 5)}`
}

export function slotStatus(robot: RobotSetupFacts, now: number): SlotStatus {
  if (robot.presence === 'unknown') return { word: 'CHECKING', tone: 'unknown', detail: `Trying ${robot.ip}`, presence: 'checking', pulse: false }
  if (robot.presence === 'offline') {
    return {
      word: 'OFFLINE',
      tone: 'unknown',
      detail: robot.lastSeen ? `Last seen ${whenOf(robot.lastSeen, now)}` : `No answer at ${robot.ip}`,
      presence: 'offline',
      pulse: false,
    }
  }
  const online = { presence: 'online' as const }
  const { setup, relay } = robot
  const step = currentStep(setup.steps)
  const title = step ? STEP_INFO[step.key].title : ''
  const number = step ? setup.steps.indexOf(step) + 1 : 0
  switch (setup.state) {
    case 'waiting':
      return { ...online, word: 'NEEDS YOU', tone: 'accent', detail: step?.prompt ? `${title}: ${promptAsk(step.prompt)}` : title, pulse: true }
    case 'running':
      return { ...online, word: 'SETTING UP', tone: 'live', detail: `${number} of ${setup.steps.length} · ${title}`, pulse: true }
    case 'failed':
      return { ...online, word: 'FAILED', tone: 'fault', detail: `At ${title}`, pulse: false }
    case 'stopped':
      return { ...online, word: 'STOPPED', tone: 'unknown', detail: `At ${title}`, pulse: false }
    case 'done':
      if (relay.state === 'exited') return { ...online, word: `${RELAY_WORD[robot.kind].toUpperCase()} STOPPED`, tone: 'warn', detail: 'Run setup again to restart it', pulse: false }
      return { ...online, word: 'READY', tone: 'ok', detail: relayLine(robot), pulse: false }
    case 'idle':
      return {
        ...online,
        word: 'ONLINE',
        tone: 'ok',
        detail: robot.lastReadyAt ? `Ready ${whenOf(robot.lastReadyAt, now)} · not set up since` : 'Not set up yet',
        pulse: false,
      }
  }
}

/** The roster's one line: "1 ready · 1 setting up · 1 offline" */
export function rosterSummary(robots: readonly RobotSetupFacts[], now: number): string {
  if (!robots.length) return 'No robots yet: add them one at a time'
  const counts = new Map<string, number>()
  for (const robot of robots) {
    const word = slotStatus(robot, now).word.toLowerCase()
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return [...counts].map(([word, n]) => `${n} ${word}`).join(' · ')
}

/** What keeps a robot's topics coming: an M20's relay on the robot, the ALOHA's bridge on this workstation */
export const RELAY_WORD = { m20: 'relay', aloha: 'bridge' } as const

/** "Relay at 10.0 Hz", "Bridge: /scan at 10.1 Hz" */
export function relayLine(robot: RobotSetupFacts): string {
  const rate = robot.relay.rateHz
  if (robot.kind === 'aloha') return rate ? `Bridge: /scan at ${rate.toFixed(1)} Hz` : 'Bridge running'
  return rate ? `Relay at ${rate.toFixed(1)} Hz` : 'Relay running'
}

/** Ready for the mission: set up, its relay (or bridge) running, still answering */
export function isReady(robot: RobotSetupFacts): boolean {
  return robot.presence === 'online' && robot.setup.state === 'done' && robot.relay.state !== 'exited'
}

/** Why the lobby cannot go on to Routes yet, or null: every robot in it has to be ready */
export function notReadyReason(robots: readonly RobotSetupFacts[]): string | null {
  if (!robots.length) return 'Add the robots first'
  const waiting = robots.filter((r) => !isReady(r)).map(nameOf)
  return waiting.length ? `Not ready yet: ${waiting.join(', ')}` : null
}

/** The slot the page opens on: a robot that needs the operator, one being set up, one that failed; else the newest
 * that answers, else the newest */
export function defaultSelection(robots: readonly RobotSetupFacts[]): string {
  const first = (state: RobotSetupFacts['setup']['state']) => robots.find((r) => r.setup.state === state)
  const robot = first('waiting') ?? first('running') ?? first('failed') ?? robots.findLast((r) => r.presence === 'online') ?? robots.at(-1)
  return robot ? robot.id : 'add'
}
