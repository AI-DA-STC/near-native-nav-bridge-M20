import { useState } from 'react'
import type { RobotSetupFacts, SetupStepFacts, SetupStepKey } from '@/shared/api'
import { cx, formatDuration } from '@/shared/lib'
import { StatusMark } from '@/shared/ui/StatusMark'
import { COMMAND_MARK, PLACE_LABEL, opensByItself, stepElapsed, stepInfo } from '../../model/setup-steps'
import { StepPrompt } from './StepPrompt'
import './StepList.css'

export interface StepListProps {
  robot: RobotSetupFacts
  now: number
}

/** The robot's steps, each with the commands it types and what came back. The step to read now is open. */
export function StepList({ robot, now }: StepListProps) {
  // The operator's own open/close, per step, until the step's status changes
  const [opened, setOpened] = useState<Partial<Record<SetupStepKey, { open: boolean; status: string }>>>({})
  return (
    <ol className="cc-setupsteps">
      {robot.setup.steps.map((step) => {
        const own = opened[step.key]
        const open = own && own.status === step.status ? own.open : opensByItself(step)
        return (
          <StepRow
            key={step.key}
            robot={robot}
            step={step}
            open={open}
            now={now}
            onToggle={() => setOpened({ ...opened, [step.key]: { open: !open, status: step.status } })}
          />
        )
      })}
    </ol>
  )
}

interface StepRowProps {
  robot: RobotSetupFacts
  step: SetupStepFacts
  open: boolean
  now: number
  onToggle: () => void
}

function StepRow({ robot, step, open, now, onToggle }: StepRowProps) {
  const info = stepInfo(step.key, robot.kind)
  const elapsed = stepElapsed(step, now)
  const bodyId = `cc-setupstep-${robot.id}-${step.key}`
  return (
    <li className={cx('cc-setupstep', `is-${step.status}`, open && 'is-open')}>
      <button type="button" className="cc-setupstep__head" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <StatusMark status={step.status} />
        <span className="cc-setupstep__letter" aria-hidden={info.letter === '·'}>
          {info.letter}
        </span>
        <span className="cc-setupstep__title">{info.title}</span>
        <span className="cc-setupstep__detail">{step.detail || info.purpose}</span>
        <span className="cc-setupstep__time">{elapsed === null ? '' : formatDuration(elapsed)}</span>
      </button>
      {open ? (
        <div className="cc-setupstep__body" id={bodyId}>
          {/* A step that only checks (the ALOHA's stack) types nothing */}
          {step.commands.length ? (
            <ul className="cc-cmds" aria-label={`${info.title}: commands`}>
              {step.commands.map((cmd, i) => (
                <li key={`${i}-${cmd.text}`} className={cx('cc-cmd', `is-${cmd.status}`)}>
                  <span className="cc-cmd__where">{PLACE_LABEL[cmd.where]}</span>
                  <code className="cc-cmd__text">
                    <span className="cc-cmd__prompt">$ </span>
                    {cmd.text}
                  </code>
                  <StatusMark status={COMMAND_MARK[cmd.status]} size={14} className="cc-cmd__mark" />
                  {cmd.note ? <span className="cc-cmd__note">{cmd.note}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {step.checks.length ? (
            <ul className="cc-checks" aria-label={`${info.title}: checks`}>
              {step.checks.map((check) => (
                <li key={check.label} className="cc-check">
                  <StatusMark status={check.ok === null ? 'pending' : check.ok ? 'done' : 'failed'} size={14} />
                  <span className="cc-check__label">{check.label}</span>
                  {check.value ? <span className="cc-check__value">{check.value}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {step.error ? <p className="cc-setupstep__error">{step.error}</p> : null}
          {step.prompt ? <StepPrompt robot={robot} prompt={step.prompt} now={now} /> : null}
        </div>
      ) : null}
    </li>
  )
}
