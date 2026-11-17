import { useState, type ReactNode } from 'react'
import type { CommandResult, MissionSnapshot } from '@/shared/api'
import { Badge } from '@/shared/ui/Badge'
import { Button } from '@/shared/ui/Button'
import { ConfirmModal } from '@/shared/ui/ConfirmModal'
import { Panel } from '@/shared/ui/Panel'
import { pushToast } from '@/shared/ui/Toast'
import { decidePlan } from '../../api/decide-plan'
import { markVerdict } from '../../api/mark-verdict'
import { sendInstruction } from '../../api/send-instruction'
import { isOperatorsTurn, type OperatorTurn } from '../../model/operator-turn'
import { contentsImageOf, contentsOf, type ImageView } from '../../model/suspicious-item'
import { ContentsPhoto } from '../suspicious-item/ContentsPhoto'
import { InstructionInput } from './InstructionInput'
import { OperatorPrompt } from './OperatorPrompt'
import { OutcomeSummary } from './OutcomeSummary'
import { PlanCard } from './PlanCard'
import { PlanStatus } from './PlanStatus'
import { Stepper } from './Stepper'
import { VerdictPanel } from './VerdictPanel'

async function answered(request: Promise<CommandResult>, done: string, body?: ReactNode) {
  const result = await request
  if (result.ok) pushToast({ tone: 'ok', title: done, body })
  else pushToast({ tone: 'warn', title: 'Not done', body: result.reason })
}

export interface OperatorPanelProps {
  snap: MissionSnapshot
  turn: OperatorTurn
  /** Start mission, owned by the app */
  startControl?: ReactNode
  onExpand: (image: ImageView) => void
  /** 1280×720: the plan card leaves out the instruction, which stays in the plan history */
  compact?: boolean
}

/** The operator's decisions: its content follows the mission, and it turns hot when it is their turn */
export function OperatorPanel({ snap, turn, startControl, onExpand, compact = false }: OperatorPanelProps) {
  const [confirm, setConfirm] = useState<'approve' | 'anomaly' | 'clear' | null>(null)
  const close = () => setConfirm(null)
  const hot = isOperatorsTurn(turn)
  const plan = snap.plans[snap.plans.length - 1]
  const meta = hot ? (
    <Badge tone="accent" icon="decision" size="sm">
      your {turn.kind === 'instruction' || turn.kind === 'start' ? 'turn' : 'decision'}
    </Badge>
  ) : plan && snap.run.status !== 'idle' ? (
    <PlanStatus status={plan.status} size="sm" />
  ) : null
  const contents = contentsOf(snap)
  const contentsImage = contentsImageOf(snap)

  let body: ReactNode
  switch (turn.kind) {
    case 'start':
      body = (
        <OperatorPrompt eyebrow={turn.hot ? 'Your turn · Start' : 'Before the start'} question="Start the mission?" detail={turn.detail} actions={startControl}>
          <Stepper showLabels steps={turn.steps} />
        </OperatorPrompt>
      )
      break
    case 'instruction':
      body = (
        <OperatorPrompt eyebrow="Your turn · Instruction" question="What should the fleet do?" detail="R1–R3 keep patrolling until you send the instruction; the planner then writes the plan.">
          <InstructionInput
            hot
            placeholder={turn.placeholder}
            onSend={(text) => {
              const usedDefault = text === turn.placeholder
              void answered(sendInstruction(usedDefault ? '' : text), 'Instruction sent', usedDefault ? 'The default instruction' : text)
            }}
          />
        </OperatorPrompt>
      )
      break
    case 'generating':
      body = (
        <OperatorPrompt
          eyebrow="Next decision · Plan approval"
          question={turn.planNumber > 1 ? `Generating plan #${turn.planNumber}…` : 'Generating plan…'}
          detail="R1–R3 are driving to their formation slots. The plan arrives in about 5 s; then you approve or deny it."
        />
      )
      break
    case 'approval':
      body = (
        <PlanCard
          plan={turn.plan}
          showInstruction={!compact}
          hot
          actions={
            <>
              <Button variant="primary" kbd="Enter" autoFocus onClick={() => setConfirm('approve')}>
                Approve plan
              </Button>
              <Button onClick={() => void answered(decidePlan(turn.plan.n, 'deny'), `Plan ${turn.plan.id} denied`, 'Back to patrol: send a new instruction.')}>
                Deny
              </Button>
            </>
          }
        />
      )
      break
    case 'running':
      body = <OperatorPrompt eyebrow={turn.eyebrow} question={turn.question} detail={turn.detail} />
      break
    case 'verdict':
      body = (
        <OperatorPrompt
          eyebrow={turn.decided ? 'Verdict given' : 'Your decision · Verdict'}
          question={turn.decided ? 'Return to formation: the dogs drive back to their slots.' : 'ANOMALY or CLEAR?'}
        >
          {contents ? <ContentsPhoto contents={contents} layout="row" onExpand={contentsImage ? () => onExpand(contentsImage) : undefined} /> : null}
          <VerdictPanel decided={turn.decided?.value} decidedAt={turn.decided?.at} onAnomaly={() => setConfirm('anomaly')} onClear={() => setConfirm('clear')} />
        </OperatorPrompt>
      )
      break
    case 'outcome':
      body = <OutcomeSummary outcome={turn.outcome} verdict={turn.verdict} total={turn.total} reason={turn.reason} facts={turn.facts} />
      break
  }

  const approving = turn.kind === 'approval' ? turn.plan : null
  return (
    <Panel title="Operator" hot={hot} meta={meta} scroll className="cc-ccpage__operator">
      {body}
      <ConfirmModal
        open={confirm === 'approve' && approving !== null}
        icon="decision"
        title={`Approve plan ${approving?.id}?`}
        confirmLabel="Approve plan"
        onCancel={close}
        onConfirm={() => {
          close()
          if (approving) void answered(decidePlan(approving.n, 'approve'), `Plan ${approving.id} approved`, 'The sweep starts.')
        }}
      >
        <p>R1, R2 and R3 sweep zones 1–3, about 5 minutes. The ALOHA stays on standby until the cordon is in place.</p>
      </ConfirmModal>
      <ConfirmModal
        open={confirm === 'anomaly'}
        tone="finding"
        icon="finding"
        title="Mark the contents ANOMALY?"
        confirmLabel="Mark ANOMALY"
        onCancel={close}
        onConfirm={() => {
          close()
          void answered(markVerdict('anomaly'), 'Verdict saved: ANOMALY', 'The mission ends here; the dogs hold the cordon.')
        }}
      >
        <p>The mission ends now and Return to formation is skipped. The photo and the verdict go to the log.</p>
      </ConfirmModal>
      <ConfirmModal
        open={confirm === 'clear'}
        icon="done"
        title="Mark the contents CLEAR?"
        confirmLabel="Mark CLEAR"
        onCancel={close}
        onConfirm={() => {
          close()
          void answered(markVerdict('clear'), 'Verdict saved: CLEAR', 'The dogs drive back to their slots.')
        }}
      >
        <p>The dogs drive back to their slots in the line; the mission is complete when all three are there.</p>
      </ConfirmModal>
    </Panel>
  )
}
