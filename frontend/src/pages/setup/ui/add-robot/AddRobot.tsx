import { useId, useState, type FormEvent } from 'react'
import type { RobotKind, RobotSetupFacts, RobotSuggestion } from '@/shared/api'
import { cx } from '@/shared/lib'
import { Button } from '@/shared/ui/Button'
import { Panel } from '@/shared/ui/Panel'
import { RobotTag } from '@/shared/ui/RobotTag'
import { SegmentedControl } from '@/shared/ui/SegmentedControl'
import { StatusDot } from '@/shared/ui/StatusDot'
import { addRobot } from '../../api/robot-commands'
import { defaultsFor, problemWith, type NewRobot } from '../../model/add-robot'
import { KIND_LABEL, identityOf, nameOf } from '../../model/roster'
import { STEPS_OF, stepInfo } from '../../model/setup-steps'
import './AddRobot.css'

export interface AddRobotProps {
  robots: readonly RobotSetupFacts[]
  suggestions: readonly RobotSuggestion[]
  /** The robot joined the lobby: select it */
  onAdded: (id: string) => void
}

/** Adds one robot at a time: the README's robots first, any other by ID and IP */
export function AddRobot({ robots, suggestions, onAdded }: AddRobotProps) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<NewRobot>(() => defaultsFor('m20', suggestions.filter((s) => s.presence === 'online').concat(suggestions)))
  const [touched, setTouched] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const passwordId = useId()

  const add = (robot: NewRobot, from: 'form' | 'list') => {
    setBusy(from === 'form' ? 'form' : robot.id)
    setError(null)
    void addRobot(robot).then((result) => {
      setBusy(null)
      if (result.ok) onAdded(robot.id.trim())
      else setError(result.error)
    })
  }
  const problem = problemWith(draft, robots)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setTouched(true)
    if (!problem) add(draft, 'form')
  }

  return (
    <div className="cc-addbay">
      <Panel className="cc-add" title="Add a robot" scroll>
        <div className="cc-add__body">
          {suggestions.length ? (
            <section aria-labelledby="cc-add-readme">
              <h3 className="cc-add__heading" id="cc-add-readme">
                From the README
              </h3>
              <ul className="cc-add__list">
                {suggestions.map((s) => {
                  const identity = identityOf(s)
                  // One primary button: the first robot that answers
                  const first = s === suggestions.find((x) => x.presence === 'online')
                  return (
                    <li key={s.id} className={cx('cc-add__row', `is-${s.presence}`)}>
                      <span className="cc-add__who">
                        {identity ? <RobotTag robot={identity} showId={false} showLabel={identity !== 'aloha'} size="sm" /> : null}
                        <span className="cc-add__name">{nameOf(s)}</span>
                      </span>
                      <span className="cc-add__ip">{s.ip}</span>
                      <span className="cc-add__kind">{KIND_LABEL[s.kind]}</span>
                      <span className={cx('cc-add__presence', s.presence === 'online' ? 'cc-tone--ok' : 'cc-tone--muted')}>
                        <StatusDot tone={s.presence === 'online' ? 'ok' : 'unknown'} pulse={false} size={7} />
                        {s.presence === 'online' ? 'online' : s.presence === 'offline' ? 'offline' : 'checking'}
                      </span>
                      <Button
                        size="sm"
                        variant={first ? 'primary' : 'secondary'}
                        disabled={busy !== null}
                        onClick={() => add({ kind: s.kind, id: s.id, ip: s.ip, user: s.user, password: '' }, 'list')}
                      >
                        {busy === s.id ? 'Adding…' : `Add ${nameOf(s)}`}
                      </Button>
                    </li>
                  )
                })}
              </ul>
            </section>
          ) : (
            <p className="cc-add__all">Every robot in the README’s table is in the lobby.</p>
          )}

          <form className="cc-add__form" onSubmit={submit} aria-labelledby="cc-add-other" noValidate>
            <h3 className="cc-add__heading" id="cc-add-other">
              By robot ID, login and password
            </h3>
            <div className="cc-add__fields">
              <label className="cc-add__field">
                <span>Kind</span>
                <SegmentedControl<RobotKind>
                  size="md"
                  label="Kind"
                  value={draft.kind}
                  options={[
                    { value: 'm20', label: 'M20' },
                    { value: 'aloha', label: 'Mobile ALOHA' },
                  ]}
                  onChange={(kind) => setDraft(defaultsFor(kind, suggestions))}
                />
              </label>
              <label className="cc-add__field">
                <span>Robot ID</span>
                <input
                  className="cc-input cc-add__input"
                  value={draft.id}
                  placeholder="741"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                />
              </label>
              <div className="cc-add__field cc-add__field--login">
                <span id="cc-add-login">Login</span>
                <span className="cc-add__login" role="group" aria-labelledby="cc-add-login">
                  <input
                    className="cc-input cc-add__input cc-add__user"
                    aria-label="User"
                    value={draft.user}
                    placeholder={draft.kind === 'aloha' ? 'agilex' : 'user'}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => setDraft({ ...draft, user: e.target.value })}
                  />
                  <span className="cc-add__at" aria-hidden="true">
                    @
                  </span>
                  <input
                    className="cc-input cc-add__input cc-add__ip-input"
                    aria-label="Static IP"
                    value={draft.ip}
                    placeholder="192.168.123.100"
                    spellCheck={false}
                    autoComplete="off"
                    inputMode="decimal"
                    onChange={(e) => setDraft({ ...draft, ip: e.target.value })}
                  />
                </span>
              </div>
              <div className="cc-add__field">
                <label htmlFor={passwordId}>Password</label>
                <span className="cc-add__secret">
                  <input
                    id={passwordId}
                    className="cc-input cc-add__input cc-add__password"
                    type={showPassword ? 'text' : 'password'}
                    value={draft.password}
                    placeholder="README’s"
                    autoComplete="new-password"
                    onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                  />
                  <button
                    type="button"
                    className="cc-add__show"
                    aria-pressed={showPassword}
                    aria-label={showPassword ? 'Hide the password' : 'Show the password'}
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                </span>
              </div>
              <Button type="submit" disabled={busy !== null}>
                {busy === 'form' ? 'Adding…' : 'Add robot'}
              </Button>
            </div>
            <p className={cx('cc-add__note', touched && problem && 'cc-tone--fault')}>
              {touched && problem ? (
                problem
              ) : draft.kind === 'aloha' ? (
                <>
                  The ALOHA logs in as agilex; an empty password is start_aloha.sh’s (<code>agx</code>). Passwords stay on this workstation.
                </>
              ) : (
                <>
                  The ID suffixes every topic its relays publish (/ODOM_relayed_741). An empty password is the README’s (<code>{"'"}</code>), for ssh and
                  su. Passwords stay on this workstation.
                </>
              )}
            </p>
          </form>
          {error ? <p className="cc-add__error">{error}</p> : null}
        </div>
      </Panel>

      <Panel className="cc-add__how" title="What setup does" scroll>
        <p className="cc-add__lead">
          {draft.kind === 'aloha' ? (
            <>
              Adding the ALOHA while it answers starts its setup at once: <code>bash start_aloha.sh</code> on the robot, each part checked on its
              ROS master, its bridge here, then you localize it on its own map in RViz. You answer when a step needs you; the terminals stay
              under <b>Terminals</b>.
            </>
          ) : (
            <>
              Adding an online M20 starts its setup at once: the README’s commands, typed one by one into two terminals on this workstation, each
              once the prompt is back. You answer when a step needs you; the terminals stay under <b>Terminals</b>.
            </>
          )}
        </p>
        <ol className="cc-add__steps">
          {STEPS_OF[draft.kind].map((key) => {
            const info = stepInfo(key, draft.kind)
            return (
              <li key={key}>
                <span className="cc-add__letter">{info.letter}</span>
                <span className="cc-add__step">{info.title}</span>
                <span className="cc-add__purpose">{info.purpose}</span>
              </li>
            )
          })}
        </ol>
        <p className="cc-add__lead">
          The robots answer on the robots’ router (near-robots-5G). A robot that does not answer joins the lobby faded, and its setup waits until
          it does.
        </p>
      </Panel>
    </div>
  )
}
