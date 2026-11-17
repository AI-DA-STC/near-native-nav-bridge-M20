import type { IconName } from '@/shared/ui/Icon'

/** Step marks: pending ○ · active ▶ · done ✓ · failed ✕ · stopped ■ · skipped – · decision ◆ (the operator's turn) */
export type StepStatus = 'pending' | 'active' | 'done' | 'failed' | 'stopped' | 'skipped' | 'decision'

export const STEP_MARKS: Readonly<Record<StepStatus, { icon: IconName; word: string; tone: string }>> = {
  pending: { icon: 'pending', word: 'Pending', tone: 'muted' },
  active: { icon: 'active', word: 'Active', tone: 'live' },
  done: { icon: 'done', word: 'Done', tone: 'ok' },
  failed: { icon: 'failed', word: 'Failed', tone: 'fault' },
  stopped: { icon: 'stopped', word: 'Stopped', tone: 'unknown' },
  skipped: { icon: 'skipped', word: 'Skipped', tone: 'unknown' },
  decision: { icon: 'decision', word: 'Your decision', tone: 'accent' },
}
