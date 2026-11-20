import { useNavigate, useSearchParams } from 'react-router'
import { terminalStream, useSetupConnection, useSetupSnapshot } from '@/shared/api'
import { cx, formatTimeOfDay } from '@/shared/lib'
import { Badge } from '@/shared/ui/Badge'
import { Button } from '@/shared/ui/Button'
import { Panel } from '@/shared/ui/Panel'
import { StatusDot } from '@/shared/ui/StatusDot'
import { XtermPane } from '@/shared/ui/XtermPane'
import { groupName, pickSession, sessionAbout, sessionGroups, sessionTitle } from '../model/session-groups'
import './TerminalsPage.css'

/** Every terminal the setup opened, live: the robots' relay sessions and the laptop's. Typing goes to the one in front. */
export function TerminalsPage() {
  const snapshot = useSetupSnapshot()
  const connection = useSetupConnection()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  if (!snapshot) {
    return <p className="cc-terms__empty">{connection === 'connecting' ? 'Connecting to the setup server…' : 'The setup server does not answer.'}</p>
  }
  const groups = sessionGroups(snapshot)
  const session = pickSession(snapshot, params.get('session'))
  if (!session) {
    return (
      <div className="cc-terms__empty">
        <p>No terminals yet: each robot’s open when its setup starts.</p>
        <Button onClick={() => navigate('/setup')}>Go to Setup</Button>
      </div>
    )
  }
  const robotName = (id: string) => groupName(id, snapshot)
  const kindOf = (id: string) => snapshot.robots.find((r) => r.id === id)?.kind ?? null
  const title = (s: { robot: string; role: typeof session.role }) => sessionTitle(s.role, kindOf(s.robot))
  return (
    <div className="cc-terms">
      <Panel className="cc-terms__list" title="Terminals" scroll>
        {groups.map((group) => (
          <section key={group.robot} className="cc-terms__group" aria-label={`Robot ${group.robot}`}>
            <h3 className="cc-terms__robot">
              <span>{robotName(group.robot)}</span>
              {group.facts ? (
                <>
                  <span className="cc-terms__ip">{group.facts.ip}</span>
                  <StatusDot tone={group.facts.presence === 'online' ? 'ok' : 'unknown'} size={7} label={group.facts.presence} />
                </>
              ) : (
                <span className="cc-terms__ip">{group.robot === 'routes' ? 'recorder' : 'removed'}</span>
              )}
            </h3>
            <ul className="cc-terms__sessions">
              {group.sessions.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className={cx('cc-terms__session', s.id === session.id && 'is-selected')}
                    aria-current={s.id === session.id}
                    onClick={() => setParams({ session: s.id })}
                  >
                    <span className="cc-terms__role">
                      {title(s)}
                      <Badge size="sm" tone={s.state === 'running' ? 'ok' : 'neutral'}>
                        {s.state}
                      </Badge>
                    </span>
                    <span className="cc-terms__activity">{s.activity}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </Panel>
      <Panel
        className="cc-terms__view"
        title={`${robotName(session.robot)} · ${title(session)}`}
        flush
        meta={
          <>
            <span className="cc-terms__since">opened {formatTimeOfDay(session.startedAt)}</span>
            <Button size="sm" disabled={session.state !== 'running'} onClick={() => terminalStream(session.id).input('\x03')} title="Interrupt what runs in it">
              Ctrl+C
            </Button>
          </>
        }
      >
        <div className="cc-terms__body">
          <p className="cc-terms__about">{sessionAbout(session.role, kindOf(session.robot))}. What you type here goes to this terminal.</p>
          <XtermPane key={session.id} feed={terminalStream(session.id)} label={`${robotName(session.robot)} · ${title(session)} terminal`} className="cc-terms__xterm" />
        </div>
      </Panel>
    </div>
  )
}
