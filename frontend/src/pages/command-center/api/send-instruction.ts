import { sendCommand, type CommandResult } from '@/shared/api'

/** The operator's instruction for the plan; empty sends the default instruction */
export function sendInstruction(text: string): Promise<CommandResult> {
  return sendCommand({ type: 'instruction', text })
}
