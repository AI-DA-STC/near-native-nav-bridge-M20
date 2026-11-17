import type { PlanStatusKey } from '@/shared/api'
import type { Tone } from '@/shared/lib'
import { Badge } from '@/shared/ui/Badge'
import type { IconName } from '@/shared/ui/Icon'

const PLAN: Record<PlanStatusKey, { tone: Tone; outline?: boolean; icon: IconName; word: string }> = {
  generating: { tone: 'live', icon: 'clock', word: 'Generating' },
  // the operator's turn
  awaiting: { tone: 'accent', icon: 'decision', word: 'Awaiting approval' },
  approved: { tone: 'ok', icon: 'done', word: 'Approved' },
  executing: { tone: 'live', icon: 'active', word: 'Executing' },
  completed: { tone: 'ok', icon: 'done', word: 'Completed' },
  // a choice, not a failure: the plan stays in the history
  denied: { tone: 'neutral', icon: 'loop', word: 'Denied' },
  stopped: { tone: 'neutral', icon: 'stopped', word: 'Stopped' },
  failed: { tone: 'fault', icon: 'failed', word: 'Failed' },
  undecided: { tone: 'neutral', outline: true, icon: 'pending', word: 'Not decided' },
}

/** The plan's status in its fixed vocabulary */
export function PlanStatus({ status = 'undecided', size = 'md' }: { status?: PlanStatusKey; size?: 'sm' | 'md' }) {
  const p = PLAN[status]
  return (
    <Badge tone={p.tone} variant={p.outline ? 'outline' : 'tint'} icon={p.icon} size={size} className={status === 'generating' ? 'is-working' : undefined}>
      {p.word}
    </Badge>
  )
}
