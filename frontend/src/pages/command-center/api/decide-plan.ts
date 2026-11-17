import { sendCommand, type CommandResult } from '@/shared/api'

/** Approve sends the robots on the plan; deny sends the mission back to Patrol, the plan kept in the history */
export function decidePlan(plan: number, decision: 'approve' | 'deny'): Promise<CommandResult> {
  return sendCommand({ type: 'decide-plan', plan, decision })
}
