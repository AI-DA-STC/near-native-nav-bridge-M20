import { terminalStream, useSetupConnection, useSetupSnapshot } from '@/shared/api'
import { Badge } from '@/shared/ui/Badge'
import { XtermPane } from '@/shared/ui/XtermPane'
import { pingPanes, rowsOf } from '../model/ping-panes'
import './FleetHealthPage.css'

/** The link to each robot and the router, live: a ping dashboard each (its own header names it), in terminals the
 * setup server runs from its start, sharing the screen. Keys typed go to the one clicked. */
export function FleetHealthPage() {
  const snapshot = useSetupSnapshot()
  const connection = useSetupConnection()
  if (!snapshot) {
    return <p className="cc-health__empty">{connection === 'connecting' ? 'Connecting to the setup server…' : 'The setup server does not answer.'}</p>
  }
  const panes = pingPanes(snapshot)
  if (!panes.length) {
    return <p className="cc-health__empty">No ping terminals: one opens for each robot added in Setup, and one for the router.</p>
  }
  const rows = rowsOf(panes)
  return (
    <div className="cc-health" style={{ gridTemplateRows: `repeat(${rows.length}, minmax(0, 1fr))` }}>
      {rows.map((row) => (
        <div key={row[0].session.id} className="cc-health__row">
          {row.map(({ session, name }) => (
            <section key={session.id} className="cc-health__pane" aria-label={name}>
              <XtermPane feed={terminalStream(session.id)} label={`${name} ping terminal`} />
              {session.state === 'exited' ? (
                <Badge size="sm" tone="neutral" className="cc-health__exited">
                  exited · opens again shortly
                </Badge>
              ) : null}
            </section>
          ))}
        </div>
      ))}
    </div>
  )
}
