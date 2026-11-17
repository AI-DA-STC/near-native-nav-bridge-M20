import { sendCommand, type CommandResult } from '@/shared/api'

/** ANOMALY ends the mission at once; CLEAR sends the dogs back to their slots */
export function markVerdict(value: 'anomaly' | 'clear'): Promise<CommandResult> {
  return sendCommand({ type: 'verdict', value })
}
