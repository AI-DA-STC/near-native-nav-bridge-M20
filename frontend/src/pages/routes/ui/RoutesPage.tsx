import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useSetupConnection, useSetupSnapshot, type PlanSummary, type SetupResult } from '@/shared/api'
import { Button } from '@/shared/ui/Button'
import { Panel } from '@/shared/ui/Panel'
import { pushToast } from '@/shared/ui/Toast'
import { confirmPlan, newSession, usePlanRoutes } from '../api/route-commands'
import { planWhen, selectedPlan } from '../model/plans'
import { PlanList } from './PlanList'
import { PlanPreview } from './PlanPreview'
import { SessionPanel } from './SessionPanel'
import './RoutesPage.css'

/** The second step: the mission plan's routes. Pick a plan (the latest by default) with its preview beside it, or record
 * new routes robot by robot; Use this plan goes on to the Command center. */
export function RoutesPage() {
  const snapshot = useSetupSnapshot()
  const connection = useSetupConnection()
  const navigate = useNavigate()
  const [picked, setPicked] = useState<string | null>(null)
  const plans = snapshot?.plans ?? []
  const session = snapshot?.session ?? null
  const plan = session ? (plans.find((p) => p.id === session.plan) ?? null) : selectedPlan(plans, picked)
  // A recording saved into the plan changes its waypoints: fetch them again
  const version = plan ? `${plan.recorded.length}:${plan.recorded.at(-1)?.at ?? 0}` : ''
  const { routes, error } = usePlanRoutes(plan?.id ?? null, version)

  if (!snapshot) {
    return (
      <p className="cc-routes__connecting">{connection === 'connecting' ? 'Connecting to the setup server…' : 'The setup server does not answer. Is npm run dev still running?'}</p>
    )
  }
  const setupDone = Boolean(snapshot.flow?.setupConfirmedAt)
  const use = (target: PlanSummary) =>
    confirmPlan(target.id).then((result) => {
      if (!result.ok) return result
      if (setupDone) navigate('/mission')
      else {
        pushToast({ tone: 'ok', title: `Using the plan of ${planWhen(target.id)}`, body: 'Confirm Setup too: the Command center opens once both are.' })
        navigate('/setup')
      }
      return result
    })
  return (
    <div className="cc-routes">
      {session ? (
        <SessionPanel snapshot={snapshot} session={session} plan={plan} />
      ) : (
        <Panel
          className="cc-routes__plans"
          title="Plans"
          meta={<span className="cc-routes__count">{plans.length} in demo/waypoints</span>}
          scroll
          footer={<PlanActions plan={plan} onUse={use} onRecord={() => newSession(plan?.id ?? null)} />}
        >
          <p className="cc-routes__lead">
            Each plan is a folder of <code>demo/waypoints</code>, one per recording session, with the waypoints of every phase. The one you use
            becomes <code>demo/waypoints/current</code>, which <code>demo/run_demo.sh</code> runs.
          </p>
          <PlanList plans={plans} selected={plan?.id ?? null} confirmed={snapshot.flow?.plan?.id ?? null} onSelect={setPicked} />
        </Panel>
      )}
      <PlanPreview plan={plan} routes={routes} error={error} recording={session?.recording ?? null} />
    </div>
  )
}

interface PlanActionsProps {
  plan: PlanSummary | null
  onUse: (plan: PlanSummary) => Promise<SetupResult>
  onRecord: () => Promise<SetupResult>
}

/** Use the selected plan, or record new routes starting from it */
function PlanActions({ plan, onUse, onRecord }: PlanActionsProps) {
  const [busy, setBusy] = useState<'use' | 'record' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = (what: 'use' | 'record', action: () => Promise<SetupResult>) => {
    setBusy(what)
    setError(null)
    void action().then((result) => {
      setBusy(null)
      if (!result.ok) setError(result.error)
    })
  }
  const problem = plan?.problems[0] ?? null
  return (
    <div className="cc-routes__actions">
      {error ? <p className="cc-routes__error">{error}</p> : null}
      <Button variant="secondary" disabled={busy !== null} onClick={() => run('record', onRecord)}>
        {busy === 'record' ? 'Starting…' : plan ? 'Record new routes from it' : 'Record routes'}
      </Button>
      <Button
        variant="primary"
        iconRight="chevronRight"
        disabled={!plan || problem !== null || busy !== null}
        title={problem ?? undefined}
        onClick={() => plan && run('use', () => onUse(plan))}
      >
        {busy === 'use' ? 'Using it…' : 'Use this plan'}
      </Button>
    </div>
  )
}
