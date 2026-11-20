import { sendSetupCommand, type PromptChoice, type SetupResult } from '@/shared/api'
import type { NewRobot } from '../model/add-robot'

/* What the lobby asks the setup server to do. Each resolves with the server's answer: a refusal says why. */

export function addRobot(robot: NewRobot): Promise<SetupResult> {
  const { kind, id, ip, user, password } = robot
  return sendSetupCommand({ type: 'add-robot', kind, id: id.trim(), ip: ip.trim(), user: user.trim(), password: password || null })
}

export function removeRobot(robot: string): Promise<SetupResult> {
  return sendSetupCommand({ type: 'remove-robot', robot })
}

/** From the first step; what the last run left running stops first */
export function runSetup(robot: string): Promise<SetupResult> {
  return sendSetupCommand({ type: 'start-setup', robot })
}

/** From the step that failed or was stopped */
export function retrySetup(robot: string): Promise<SetupResult> {
  return sendSetupCommand({ type: 'retry-step', robot })
}

export function stopSetup(robot: string): Promise<SetupResult> {
  return sendSetupCommand({ type: 'stop-setup', robot })
}

/** password: with retry-login, the one to log in with from now on */
export function answerPrompt(robot: string, choice: PromptChoice, password?: string): Promise<SetupResult> {
  return sendSetupCommand(password === undefined ? { type: 'answer', robot, choice } : { type: 'answer', robot, choice, password })
}

/** Every robot in the lobby is ready: on to Routes */
export function confirmSetup(): Promise<SetupResult> {
  return sendSetupCommand({ type: 'confirm-setup' })
}
