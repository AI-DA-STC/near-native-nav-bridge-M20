import type { CommandPlace, CommandStatus, RobotKind, RobotSetupFacts, SetupPrompt, SetupStepFacts, SetupStepKey } from '@/shared/api'
import type { StepStatus } from '@/shared/ui/StatusMark'

/** A robot's terminals: ssh to the robot, this workstation's checks and RViz, and an M20's nav bridge */
type SetupTerminal = 'robot' | 'laptop' | 'nav'

/** The steps as the operator's checklist names them: log in, then a–f on an M20, a–c on the ALOHA. `terminal` is where
 * the step types. */
export const STEP_INFO: Readonly<Record<SetupStepKey, { title: string; letter: string; terminal: SetupTerminal; purpose: string }>> = {
  login: { title: 'Log in', letter: '·', terminal: 'robot', purpose: 'ssh into the robot (on an M20, then su to root)' },
  image: { title: 'Pull image', letter: 'a', terminal: 'robot', purpose: 'Pull and tag the latest m20-bridge:foxy on the motion host' },
  relay: { title: 'Start relay', letter: 'b', terminal: 'robot', purpose: 'Start the container and relay the topics under the robot ID' },
  laptop: { title: 'Laptop', letter: 'c', terminal: 'laptop', purpose: 'ROS domain, Fast DDS profile and workspace on this workstation' },
  topics: { title: 'Check topics', letter: 'd', terminal: 'laptop', purpose: 'Every topic suffixed with the robot ID is listed, and odometry streams' },
  localize: { title: 'Localize', letter: 'e', terminal: 'laptop', purpose: 'Set the robot’s pose in RViz with 2D Pose Estimate' },
  nav: { title: 'Nav bridge', letter: 'f', terminal: 'nav', purpose: 'The bridge the mission’s goals reach the robot through; it moves nothing by itself' },
  start: { title: 'Start ALOHA', letter: 'a', terminal: 'robot', purpose: 'start_aloha.sh: each part in a tmux window on the robot' },
  stack: { title: 'Check its stack', letter: 'b', terminal: 'robot', purpose: 'roscore, cameras, arms, lidar, base, navigation, stream, dock: each up' },
  bridge: { title: 'Bridge', letter: 'c', terminal: 'laptop', purpose: 'aloha/bridge.sh: its topics on ROS_DOMAIN_ID=1 on this workstation' },
}

/** Each kind's steps, in order */
export const STEPS_OF: Readonly<Record<RobotKind, readonly SetupStepKey[]>> = {
  m20: ['login', 'image', 'relay', 'laptop', 'topics', 'localize', 'nav'],
  aloha: ['login', 'start', 'stack', 'bridge'],
}

export const PLACE_LABEL: Readonly<Record<CommandPlace, string>> = { laptop: 'laptop', robot: 'robot', container: 'container' }

/** A command's mark, in the step marks' terms */
export const COMMAND_MARK: Readonly<Record<CommandStatus, StepStatus>> = {
  pending: 'pending',
  running: 'active',
  done: 'done',
  failed: 'failed',
  skipped: 'skipped',
}

/** The step to look at: the one waiting for the operator, running, failed or stopped; else the last one done */
export function currentStep(steps: readonly SetupStepFacts[]): SetupStepFacts | null {
  const live = steps.find((s) => s.status === 'decision' || s.status === 'active' || s.status === 'failed' || s.status === 'stopped')
  return live ?? steps.findLast((s) => s.status === 'done') ?? null
}

/** Where Open in Terminals goes: the terminal the current step types into, else whichever one is open */
export function terminalToOpen(robot: RobotSetupFacts): { session: string; role: SetupTerminal } | null {
  const step = currentStep(robot.setup.steps)
  const first = step ? STEP_INFO[step.key].terminal : 'robot'
  const order: SetupTerminal[] = [first, ...(['robot', 'laptop', 'nav'] as const).filter((r) => r !== first)]
  for (const role of order) {
    const session = robot.sessions[role]
    if (session) return { session, role }
  }
  return null
}

/** The Terminals screen on one session (pages/terminals reads ?session=) */
export function terminalsLink(session: string): string {
  return `/terminals?session=${encodeURIComponent(session)}`
}

/** Opened in the list without a click: what the operator should read now */
export function opensByItself(step: SetupStepFacts): boolean {
  return step.status === 'decision' || step.status === 'active' || step.status === 'failed' || step.status === 'stopped'
}

/** What a prompt asks, in a few words, for the roster and the header */
export function promptAsk(prompt: SetupPrompt): string {
  switch (prompt.kind) {
    case 'registry':
      return 'trust the registry on the robot'
    case 'pull-failed':
      return 'the pull failed'
    case 'relay-running':
      return 'a relay is already running'
    case 'host-key':
      return 'its SSH host key changed'
    case 'localize':
      return 'set its pose in RViz'
    case 'password':
      return 'its password was refused'
    case 'aloha-running':
      return 'start_aloha.sh is already running'
  }
}

/** How long a step took, or has taken so far */
export function stepElapsed(step: SetupStepFacts, now: number): number | null {
  if (step.startedAt === null) return null
  return (step.endedAt ?? now) - step.startedAt
}
