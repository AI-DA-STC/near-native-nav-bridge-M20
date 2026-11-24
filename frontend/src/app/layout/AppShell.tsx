import { useState, type ReactNode } from 'react'
import { Outlet, useLocation } from 'react-router'
import { useMissionSnapshot, type EStopFacts } from '@/shared/api'
import { formatTimeOfDay } from '@/shared/lib'
import { Toast, ToastRegion, dismissToast, useToasts } from '@/shared/ui/Toast'
import { EstopBanner } from './EstopBanner'
import { Header } from './Header'
import { SetupHeader } from './SetupHeader'
import { useMissionToasts } from './mission-toasts'
import { useSetupToasts } from './setup-toasts'
import './AppShell.css'

/** The app-wide shell: the header band, the screen under it, and what sits above everything. The Command center has
 * the mission's header; Setup and Terminals have the fleet setup's. */
export function AppShell() {
  const snap = useMissionSnapshot()
  const mission = useLocation().pathname.startsWith('/mission')
  useSetupToasts()
  useMissionToasts()
  return (
    <div className="cc-shell">
      {!mission ? <SetupHeader /> : snap ? <Header snap={snap} /> : null}
      <main className="cc-shell__main">
        <Outlet />
      </main>
      {snap?.estop ? <MissionEstopBanner estop={snap.estop} /> : null}
      <ToastHost />
    </div>
  )
}

/** The Command center once the mission's first snapshot is in */
export function MissionGate({ children }: { children: ReactNode }) {
  return useMissionSnapshot() ? children : <p className="cc-shell__connecting">Connecting to the mission…</p>
}

/** The E-STOP report stays until the operator dismisses it */
function MissionEstopBanner({ estop }: { estop: EStopFacts }) {
  const [dismissed, setDismissed] = useState<number | null>(null)
  if (dismissed === estop.firedAt) return null
  const done = estop.results.every((r) => r.state !== 'pending')
  return (
    <EstopBanner
      firedAt={formatTimeOfDay(estop.firedAt)}
      results={estop.results.map((r) => ({
        robot: r.robot,
        confirmed: r.state === 'confirmed',
        pending: r.state === 'pending',
        latency: r.latencyMs,
        reason: r.reason,
      }))}
      onDismiss={done ? () => setDismissed(estop.firedAt) : undefined}
    />
  )
}

function ToastHost() {
  const toasts = useToasts()
  return (
    <ToastRegion>
      {toasts.map((t) => (
        <Toast key={t.id} tone={t.tone} title={t.title} onClose={() => dismissToast(t.id)}>
          {t.body}
        </Toast>
      ))}
    </ToastRegion>
  )
}
