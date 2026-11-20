import { useEffect, useState } from 'react'
import { fetchPlanRoutes, sendSetupCommand, type PlanRoutes, type RecorderKey, type RoutePhase, type SetupResult } from '@/shared/api'

/* What the Routes screen asks the setup server: use a plan, record new routes into a session, and each plan's
 * waypoints for its preview */

/** demo/waypoints/current points at it, and Routes is confirmed */
export function confirmPlan(plan: string): Promise<SetupResult> {
  return sendSetupCommand({ type: 'confirm-plan', plan })
}

/** A new plan folder copied from `basedOn`, named in this browser's local time */
export function newSession(basedOn: string | null): Promise<SetupResult> {
  return sendSetupCommand({ type: 'new-session', basedOn, utcOffsetMinutes: -new Date().getTimezoneOffset() })
}

export function recordStart(phase: RoutePhase, robot: string, append: boolean): Promise<SetupResult> {
  return sendSetupCommand({ type: 'record-start', phase, robot, append })
}

export function recordKey(key: RecorderKey): Promise<SetupResult> {
  return sendSetupCommand({ type: 'record-key', key })
}

export function finishSession(): Promise<SetupResult> {
  return sendSetupCommand({ type: 'finish-session' })
}

export function discardSession(): Promise<SetupResult> {
  return sendSetupCommand({ type: 'discard-session' })
}

/** A plan's waypoints, fetched again whenever `version` changes (a recording saved into it) */
export function usePlanRoutes(plan: string | null, version: string): { routes: PlanRoutes | null; error: string | null } {
  const key = `${plan}|${version}`
  const [state, setState] = useState<{ key: string; routes: PlanRoutes | null; error: string | null }>({ key: '', routes: null, error: null })
  useEffect(() => {
    if (!plan) return undefined
    let live = true
    fetchPlanRoutes(plan).then(
      (routes) => live && setState({ key, routes, error: null }),
      (error: unknown) => live && setState({ key, routes: null, error: error instanceof Error ? error.message : String(error) }),
    )
    return () => {
      live = false
    }
  }, [plan, key])
  // Until the new one comes, the routes shown are the plan's last (a save redraws without a blank)
  return state.key === key || state.routes?.id === plan ? state : { routes: null, error: null }
}
