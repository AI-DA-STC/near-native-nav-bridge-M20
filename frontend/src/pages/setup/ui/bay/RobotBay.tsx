import { useState } from 'react'
import { useNavigate } from 'react-router'
import type { RobotSetupFacts, RobotSuggestion, SetupResult, SetupSnapshot, TerminalRole } from '@/shared/api'
import { cx, formatDuration } from '@/shared/lib'
import { Button } from '@/shared/ui/Button'
import { ConfirmModal } from '@/shared/ui/ConfirmModal'
import { Panel } from '@/shared/ui/Panel'
import { StatusDot } from '@/shared/ui/StatusDot'
import { removeRobot, retrySetup, runSetup, stopSetup } from '../../api/robot-commands'
import { KIND_LABEL, RELAY_WORD, nameOf, nextSuggestion, relayLine, slotStatus, whenOf } from '../../model/roster'
import { STEP_INFO, currentStep, terminalToOpen, terminalsLink } from '../../model/setup-steps'
import { StepList } from './StepList'
import './RobotBay.css'

export interface RobotBayProps {
  robot: RobotSetupFacts
  snapshot: SetupSnapshot
  now: number
  onAddNext: () => void
  /** On to Routes */
  onContinue: () => void
  /** Why the lobby cannot go on yet, or null */
  continueBlocked: string | null
  onRemoved: () => void
}

/** The selected robot's setup, step by step. The terminals the steps type into are under Terminals. */
export function RobotBay({ robot, snapshot, now, onAddNext, onContinue, continueBlocked, onRemoved }: RobotBayProps) {
  const setup = robot.setup
  const running = setup.state === 'running' || setup.state === 'waiting'
  const took = setup.startedAt ? formatDuration((setup.endedAt ?? now) - setup.startedAt) : null
  return (
    <div className="cc-bay">
      <Panel
        className="cc-bay__steps"
        title={<BayTitle robot={robot} now={now} />}
        hot={setup.state === 'waiting'}
        meta={<BayActions robot={robot} onRemoved={onRemoved} />}
        scroll
        footer={
          setup.state === 'done' ? (
            <SetupDone
              robot={robot}
              next={nextSuggestion(snapshot.suggestions)}
              onAddNext={onAddNext}
              onContinue={onContinue}
              continueBlocked={continueBlocked}
              now={now}
            />
          ) : (
            <p className="cc-bay__run">
              {RUN_WORDS[setup.state]}
              {took && setup.state !== 'idle' ? <span className="cc-bay__took"> · {took}</span> : null}
              {running ? <span className="cc-bay__hint"> · typed into {nameOf(robot)}’s terminals, live under Terminals</span> : null}
            </p>
          )
        }
      >
        <StepList robot={robot} now={now} />
      </Panel>
    </div>
  )
}

const RUN_WORDS: Record<RobotSetupFacts['setup']['state'], string> = {
  idle: 'Not run since the setup server started',
  running: 'Setting up',
  waiting: 'Waiting for you',
  done: 'Ready',
  failed: 'Failed',
  stopped: 'Stopped',
}

function BayTitle({ robot, now }: { robot: RobotSetupFacts; now: number }) {
  const status = slotStatus(robot, now)
  return (
    <span className="cc-bay__title">
      <span>Setup · {nameOf(robot)}</span>
      <span className="cc-bay__where">
        {KIND_LABEL[robot.kind]} · {robot.ip}
      </span>
      <span className={cx('cc-bay__presence', `cc-tone--${status.presence === 'online' ? 'ok' : 'unknown'}`)}>
        <StatusDot tone={status.presence === 'online' ? 'ok' : 'unknown'} size={7} />
        {status.presence === 'online' ? 'online' : status.presence === 'offline' ? 'offline' : 'checking'}
      </span>
    </span>
  )
}

/** What Open in Terminals opens, on hover */
function terminalAbout(role: TerminalRole, name: string): string {
  return role === 'robot'
    ? `${name}’s robot terminal: ssh, su, then the container and its relay`
    : `${name}’s laptop terminal: the exports, the topic checks and rviz2`
}

/** Open in Terminals, run, stop, retry and remove: what the server refuses comes back under the buttons */
function BayActions({ robot, onRemoved }: { robot: RobotSetupFacts; onRemoved: () => void }) {
  const navigate = useNavigate()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const act = (what: string, run: () => Promise<SetupResult>, after?: () => void) => {
    setBusy(what)
    setError(null)
    void run().then((result) => {
      setBusy(null)
      if (!result.ok) setError(result.error)
      else after?.()
    })
  }
  const name = nameOf(robot)
  const state = robot.setup.state
  const online = robot.presence === 'online'
  const offlineReason = online ? undefined : `${name} does not answer at ${robot.ip}`
  const step = currentStep(robot.setup.steps)
  const terminal = terminalToOpen(robot)
  return (
    <div className="cc-bay__actions">
      {terminal ? (
        <Button size="sm" variant="ghost" icon="external" title={terminalAbout(terminal.role, name)} onClick={() => navigate(terminalsLink(terminal.session))}>
          Open in Terminals
        </Button>
      ) : null}
      {state === 'running' || state === 'waiting' ? (
        <Button size="sm" disabled={busy !== null} onClick={() => act('stop', () => stopSetup(robot.id))}>
          {busy === 'stop' ? 'Stopping…' : 'Stop setup'}
        </Button>
      ) : (
        <>
          {(state === 'failed' || state === 'stopped') && step ? (
            <Button size="sm" variant="primary" disabled={busy !== null || !online} title={offlineReason} onClick={() => act('retry', () => retrySetup(robot.id))}>
              {busy === 'retry' ? 'Starting…' : `Retry from ${STEP_INFO[step.key].title.toLowerCase()}`}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={state === 'idle' ? 'primary' : 'secondary'}
            disabled={busy !== null || !online}
            title={offlineReason}
            onClick={() => act('run', () => runSetup(robot.id))}
          >
            {busy === 'run' ? 'Starting…' : state === 'idle' ? `Set up ${name}` : 'Run setup again'}
          </Button>
        </>
      )}
      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirmRemove(true)}>
        Remove
      </Button>
      {error ? <span className="cc-bay__error">{error}</span> : null}
      <ConfirmModal
        open={confirmRemove}
        title={`Remove ${name} from the lobby?`}
        confirmLabel={`Remove ${name}`}
        tone="danger"
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false)
          act('remove', () => removeRobot(robot.id), onRemoved)
        }}
      >
        {robot.kind === 'aloha' ? (
          <>
            Its bridge here stops, and <code>bash start_aloha.sh stop</code> stops all that start_aloha.sh started on it: the arms, the base,
            navigation. Its terminals close. The lobby forgets {robot.ip}; you can add it again.
          </>
        ) : (
          <>
            The relay this console started on {name} stops, its terminals close and RViz with them. The lobby forgets {robot.ip}; you can add it
            again.
          </>
        )}
      </ConfirmModal>
    </div>
  )
}

interface SetupDoneProps {
  robot: RobotSetupFacts
  next: RobotSuggestion | null
  now: number
  onAddNext: () => void
  onContinue: () => void
  continueBlocked: string | null
}

/** Ready: what the setup found, then the next robot, or on to Routes */
function SetupDone({ robot, next, now, onAddNext, onContinue, continueBlocked }: SetupDoneProps) {
  const name = nameOf(robot)
  // Each ends localized: an M20 on the dogs' map, the ALOHA on its own
  const last = robot.setup.steps.find((s) => s.key === 'localize')
  const relayStopped = robot.relay.state === 'exited'
  return (
    <div className="cc-done">
      <div className="cc-done__text">
        <p className={cx('cc-done__title', relayStopped ? 'cc-tone--warn' : 'cc-tone--ok')}>
          {relayStopped ? `${name}’s ${RELAY_WORD[robot.kind]} has stopped` : `${name} is ready`}
        </p>
        <p className="cc-done__facts">
          {relayStopped ? '' : `${relayLine(robot)} · `}
          {last?.detail}
          {robot.setup.endedAt ? ` · ${whenOf(robot.setup.endedAt, now)}` : ''}
        </p>
      </div>
      <div className="cc-done__actions">
        {next ? (
          <Button variant="primary" iconRight="chevronRight" onClick={onAddNext}>
            Add the next robot · {nameOf(next)}
          </Button>
        ) : null}
        <Button variant={next || continueBlocked ? 'secondary' : 'primary'} disabled={continueBlocked !== null} title={continueBlocked ?? undefined} onClick={onContinue}>
          Continue to Routes
        </Button>
      </div>
    </div>
  )
}
