import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import type { PromptChoice, RobotSetupFacts, SetupPrompt } from '@/shared/api'
import { formatTimeOfDay } from '@/shared/lib'
import { Button } from '@/shared/ui/Button'
import { Icon } from '@/shared/ui/Icon'
import { answerPrompt } from '../../api/robot-commands'
import { nameOf } from '../../model/roster'
import { terminalsLink } from '../../model/setup-steps'
import './StepPrompt.css'

export interface StepPromptProps {
  robot: RobotSetupFacts
  prompt: SetupPrompt
  now: number
}

/** What the setup waits for, in the step: what happened, what to do, and the answers */
export function StepPrompt({ robot, prompt, now }: StepPromptProps) {
  const navigate = useNavigate()
  const [sent, setSent] = useState<PromptChoice | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const answer = (choice: PromptChoice) => {
    setSent(choice)
    setError(null)
    void answerPrompt(robot.id, choice, choice === 'retry-login' ? password : undefined).then((result) => {
      setSent(null)
      if (!result.ok) setError(result.error)
    })
  }
  const busy = sent !== null
  const name = nameOf(robot)
  // Trusting the registry is done by hand, in the robot's terminal under Terminals
  const terminal = prompt.kind === 'registry' ? robot.sessions.robot : null
  // A new question comes into view, even when the step list is scrolled elsewhere
  const box = useRef<HTMLElement>(null)
  useEffect(() => {
    box.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  }, [prompt.kind])
  const logInAgain = (e: FormEvent) => {
    e.preventDefault()
    if (password) answer('retry-login')
  }
  return (
    <section className="cc-prompt" aria-live="polite" ref={box}>
      <PromptBody robot={robot} name={name} prompt={prompt} now={now} />
      {prompt.kind === 'password' ? (
        <form className="cc-prompt__password" onSubmit={logInAgain}>
          <label className="cc-prompt__field">
            <span>Password for {prompt.login}</span>
            <input
              className="cc-input cc-prompt__input"
              type="password"
              value={password}
              autoComplete="off"
              autoFocus
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <Button type="submit" variant="primary" disabled={busy || !password}>
            {sent === 'retry-login' ? 'Logging in…' : 'Log in again'}
          </Button>
        </form>
      ) : null}
      <div className="cc-prompt__actions">
        {terminal ? (
          <Button variant="ghost" icon="external" onClick={() => navigate(terminalsLink(terminal))}>
            Open the robot terminal
          </Button>
        ) : null}
        {choicesOf(prompt, name).map(({ choice, label, primary }) => (
          <Button key={choice} variant={primary ? 'primary' : 'secondary'} disabled={busy} onClick={() => answer(choice)}>
            {sent === choice ? 'Sending…' : label}
          </Button>
        ))}
      </div>
      {error ? <p className="cc-prompt__error">{error}</p> : null}
    </section>
  )
}

function choicesOf(prompt: SetupPrompt, name: string): Array<{ choice: PromptChoice; label: string; primary?: boolean }> {
  switch (prompt.kind) {
    case 'registry':
      return [
        { choice: 'retry', label: 'Retry pull', primary: true },
        { choice: 'stop', label: 'Stop setup' },
      ]
    case 'pull-failed':
      return [
        { choice: 'retry', label: 'Retry pull', primary: true },
        { choice: 'skip', label: 'Use the image on the robot' },
        { choice: 'stop', label: 'Stop setup' },
      ]
    case 'relay-running':
      return [
        { choice: 'restart-container', label: 'Restart the container', primary: true },
        { choice: 'keep-relay', label: 'Keep it' },
        { choice: 'stop', label: 'Stop setup' },
      ]
    case 'host-key':
      return [
        { choice: 'remove-host-key', label: 'Remove the old key and retry', primary: true },
        { choice: 'stop', label: 'Stop setup' },
      ]
    case 'localize':
      return [
        { choice: 'localized', label: `${name} is localized`, primary: true },
        ...(prompt.rviz === 'closed' ? [{ choice: 'open-rviz' as const, label: 'Open RViz again' }] : []),
      ]
    // Log in again is the form above, with the password
    case 'password':
      return [{ choice: 'stop', label: 'Stop setup' }]
    case 'aloha-running':
      return [
        { choice: 'keep-aloha', label: 'Keep it', primary: true },
        { choice: 'restart-aloha', label: 'Restart it' },
        { choice: 'stop', label: 'Stop setup' },
      ]
  }
}

function PromptBody({ robot, name, prompt, now }: { robot: RobotSetupFacts; name: string; prompt: SetupPrompt; now: number }) {
  switch (prompt.kind) {
    case 'registry':
      return (
        <>
          <h3 className="cc-prompt__title">{name}’s Docker does not trust this workstation’s registry</h3>
          <p className="cc-prompt__error-line">{prompt.error}</p>
          <p>
            In {name}’s robot terminal, under Terminals (it is already root on {name}), add <code>{prompt.registry}</code> to{' '}
            <code>insecure-registries</code> in <code>/etc/docker/daemon.json</code>, keeping what the file already has, then restart Docker:
          </p>
          <pre className="cc-prompt__snippet">
            {`# /etc/docker/daemon.json\n{ "insecure-registries": ["${prompt.registry}"] }\nsudo systemctl restart docker`}
          </pre>
          <p className="cc-prompt__warn">
            <Icon name="warn" size={14} /> Restarting Docker stops every container on the robot.
          </p>
        </>
      )
    case 'pull-failed':
      return (
        <>
          <h3 className="cc-prompt__title">The pull failed</h3>
          <p className="cc-prompt__error-line">{prompt.error}</p>
          <p>Is the registry running on this workstation? The robot can also go on with the m20-bridge:foxy it already has.</p>
        </>
      )
    case 'relay-running':
      return (
        <>
          <h3 className="cc-prompt__title">A relay for {name} is already running</h3>
          <p>
            <code>{prompt.topic}</code> has {prompt.publishers} publisher{prompt.publishers === 1 ? '' : 's'}: a relay left from an earlier session, or
            one started by hand. A second one would publish every topic twice.
          </p>
          <p>
            <b>Restart the container</b> types <code>docker compose restart nav_cmd_bridge</code>, which stops it, then launches the relay here.{' '}
            <b>Keep it</b> uses it as it is: its output is not in this console.
          </p>
        </>
      )
    case 'host-key':
      return (
        <>
          <h3 className="cc-prompt__title">{name}’s SSH host key changed</h3>
          <p>
            This workstation knows another key for {prompt.ip}: the robot was reinstalled, or another robot has its IP. Removing the old key
            types <code>ssh-keygen -R {prompt.ip}</code> and logs in again, accepting the new key.
          </p>
        </>
      )
    case 'password':
      return (
        <>
          <h3 className="cc-prompt__title">{name} refused the password</h3>
          <p className="cc-prompt__error-line">{prompt.error}</p>
          <p>Type {prompt.login}’s password: it replaces the one saved for {name} on this workstation, and the login runs again.</p>
        </>
      )
    case 'aloha-running':
      return (
        <>
          <h3 className="cc-prompt__title">start_aloha.sh is already running on the ALOHA</h3>
          <p>
            Its tmux session <code>aloha</code> is there from before: started by an earlier setup, or by hand. <b>Keep it</b> goes on with it as it
            is. <b>Restart it</b> types <code>bash start_aloha.sh stop</code>, which stops every part (the arms, the base, navigation), then starts
            them again.
          </p>
        </>
      )
    case 'localize':
      return (
        <>
          <h3 className="cc-prompt__title">Localize {name} in RViz</h3>
          {robot.kind === 'aloha' ? (
            <ol className="cc-prompt__list">
              <li>
                The RViz window <code>aloha.rviz</code> shows the ALOHA’s own map (<code>/map</code> through its bridge, ROS_DOMAIN_ID=1), its laser
                scan and AMCL’s particles, in the <code>map</code> frame.
              </li>
              <li>
                Pick <b>2D Pose Estimate</b>, click where the ALOHA stands and drag towards where it faces. It goes to <code>/initialpose</code>,
                which the bridge passes to AMCL on the robot.
              </li>
              <li>The laser scan should now lie on the map’s walls, and AMCL’s pose below follow your estimate. Then confirm below.</li>
            </ol>
          ) : (
            <ol className="cc-prompt__list">
              <li>
                The RViz window <code>robot_{robot.id}.rviz</code> shows {name}’s own map (<code>/GRID_MAP_relayed_{robot.id}</code>), odometry and
                waypoints, in the <code>map</code> frame.
              </li>
              <li>
                Pick <b>2D Pose Estimate</b>, click where {name} stands and drag towards where it faces. It goes to{' '}
                <code>/initialpose_relayed_{robot.id}</code>.
              </li>
              <li>The odometry should now sit on the map where {name} stands. Then confirm below.</li>
            </ol>
          )}
          <dl className="cc-prompt__facts">
            <dt>RViz</dt>
            <dd className={prompt.rviz === 'running' ? 'cc-tone--ok' : 'cc-tone--warn'}>{prompt.rviz === 'running' ? 'Open' : 'Closed'}</dd>
            <dt>Pose estimate</dt>
            <dd>
              {prompt.pose ? (
                <span className="cc-tone--live">
                  x {prompt.pose.x.toFixed(2)} m, y {prompt.pose.y.toFixed(2)} m, heading {Math.round(prompt.pose.yaw)}° · {formatTimeOfDay(prompt.pose.at)}
                  {now - prompt.pose.at < 10_000 ? ' · just now' : ''}
                </span>
              ) : (
                <span className="cc-tone--muted">None received yet</span>
              )}
            </dd>
            {robot.kind === 'aloha' ? (
              <>
                <dt>AMCL</dt>
                <dd>
                  {prompt.amcl ? (
                    <span className={prompt.pose && prompt.amcl.at >= prompt.pose.at ? 'cc-tone--ok' : undefined}>
                      x {prompt.amcl.x.toFixed(2)} m, y {prompt.amcl.y.toFixed(2)} m, heading {Math.round(prompt.amcl.yaw)}° ·{' '}
                      {formatTimeOfDay(prompt.amcl.at)}
                    </span>
                  ) : (
                    <span className="cc-tone--muted">No pose from AMCL yet</span>
                  )}
                </dd>
              </>
            ) : null}
          </dl>
        </>
      )
  }
}
