import type { LogTag, MissionSnapshot, PlanStatusKey } from '@/shared/api'
import { formatTimeOfDay } from '@/shared/lib'

export interface TimelineRow {
  id: string
  /** Clock time, not elapsed: "10:42:07" */
  time: string
  tag: LogTag
  text: string
  /** Arrived in the last few seconds: it flashes once */
  fresh: boolean
}

export interface PlanHistoryRow {
  n: number
  time: string
  plan: string
  /** Verbatim, as sent */
  instruction: string
  status: PlanStatusKey
}

const FRESH_MS = 2500

/** The mission's history, newest at the bottom */
export function timelineOf(snap: MissionSnapshot): TimelineRow[] {
  return snap.timeline.map((e) => ({
    id: e.id,
    time: formatTimeOfDay(e.at),
    tag: e.tag,
    text: e.text,
    fresh: snap.serverTime - e.at < FRESH_MS,
  }))
}

/** Every plan of this run, the denied ones included, newest last */
export function planHistoryOf(snap: MissionSnapshot): PlanHistoryRow[] {
  return snap.plans.map((p) => ({
    n: p.n,
    time: formatTimeOfDay(p.createdAt),
    plan: p.id ?? '—',
    instruction: p.instruction,
    status: p.status,
  }))
}

/** The mission script's raw output, as printed */
export function outputOf(snap: MissionSnapshot): string {
  return snap.output.join('\n')
}
