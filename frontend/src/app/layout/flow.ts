import type { SetupSnapshot } from '@/shared/api'

/* The operator's way through the console: Setup, then Routes, then the Command center. The setup server holds what was
 * confirmed (snapshot.flow); Fleet health opens with the Command center. */

export interface FlowState {
  setupDone: boolean
  routesDone: boolean
  /** Both confirmed, or MISSION_UNLOCKED=1 on the server (the Command center on demo data, for a look) */
  missionOpen: boolean
}

export function flowOf(snapshot: SetupSnapshot | null): FlowState {
  // An older server sends no flow: everything stays locked
  const flow = snapshot?.flow
  const setupDone = Boolean(flow?.setupConfirmedAt)
  const routesDone = Boolean(flow?.plan)
  return { setupDone, routesDone, missionOpen: Boolean(flow?.unlocked) || (setupDone && routesDone) }
}

/** The first step not confirmed yet, else the Command center */
export function nextScreen(flow: FlowState): '/setup' | '/routes' | '/mission' {
  if (!flow.setupDone) return '/setup'
  if (!flow.routesDone) return '/routes'
  return '/mission'
}
