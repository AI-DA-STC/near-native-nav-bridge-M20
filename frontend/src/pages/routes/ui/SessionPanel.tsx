import { useState } from 'react'
import type { PlanSummary, RecorderKey, RecordingFacts, RoutePhase, RouteSessionFacts, SetupResult, SetupSnapshot } from '@/shared/api'
import { cx } from '@/shared/lib'
import { Button } from '@/shared/ui/Button'
import { ConfirmModal } from '@/shared/ui/ConfirmModal'
import { Panel } from '@/shared/ui/Panel'
import { RobotTag } from '@/shared/ui/RobotTag'
import { StatusMark } from '@/shared/ui/StatusMark'
import { discardSession, finishSession, recordKey, recordStart } from '../api/route-commands'
import { PHASES, PHASE_INFO, canSave, planWhen, recordBlocked, roleId } from '../model/plans'
import './SessionPanel.css'

export interface SessionPanelProps {
  snapshot: SetupSnapshot
  session: RouteSessionFacts
  /** The session's plan, as recorded so far */
  plan: PlanSummary | null
}

interface Choice {
  phase: RoutePhase
  robot: string
}

/** A recording session: each phase's waypoints per robot, inherited from the plan it started from or recorded now, and
 * the recorder for one robot and phase at a time */
export function SessionPanel({ snapshot, session, plan }: SessionPanelProps) {
  const [chosen, setChosen] = useState<Choice | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const recording = session.recording
  const active = recording && (recording.state === 'starting' || recording.state === 'recording') ? recording : null
  const act = (what: string, run: () => Promise<SetupResult>, after?: () => void) => {
    setBusy(what)
    setError(null)
    void run().then((result) => {
      setBusy(null)
      if (!result.ok) setError(result.error)
      else after?.()
    })
  }
  const saved = plan?.recorded.length ?? 0
  return (
    <Panel
      className="cc-session"
      title={`New routes · from ${session.basedOn ? planWhen(session.basedOn, false) : 'nothing'}`}
      meta={
        <span className="cc-session__actions">
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirmDiscard(true)}>
            Discard
          </Button>
          <Button size="sm" variant={saved ? 'primary' : 'secondary'} disabled={busy !== null || active !== null} title={active ? 'Save or cancel the recording first' : undefined} onClick={() => act('finish', finishSession)}>
            {saved ? 'Finish session' : 'Close: nothing recorded'}
          </Button>
        </span>
      }
      scroll
    >
      <p className="cc-session__lead">
        Saved as <code>demo/waypoints/{session.plan}</code>, a copy of the plan it started from: what you record replaces that robot’s waypoints in
        the phase (or adds to them). Drive each robot with its own controller.
      </p>
      <table className="cc-session__grid">
        <thead>
          <tr>
            <th scope="col">Phase</th>
            {(['r1', 'r2', 'r3'] as const).map((role) => (
              <th key={role} scope="col">
                <RobotTag robot={role} size="sm" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {PHASES.map((phase) => {
            const info = PHASE_INFO[phase]
            return (
              <tr key={phase}>
                <th scope="row">
                  <span className="cc-session__phase">{info.title}</span>
                  <span className="cc-session__needs">{info.needs}</span>
                </th>
                {(['r1', 'r2', 'r3'] as const).map((role) => {
                  const robot = roleId(role)
                  if (!info.roles.includes(role)) return <td key={role} className="cc-session__none">not in the {info.title.toLowerCase()}</td>
                  const count = plan?.phases[phase].robots[robot] ?? 0
                  const fresh = plan?.recorded.some((r) => r.phase === phase && r.robot === robot) ?? false
                  const short = info.single ? count !== 1 : count < info.min
                  const blocked = recordBlocked(snapshot, robot)
                  const isChosen = chosen?.phase === phase && chosen.robot === robot
                  const isActive = active?.phase === phase && active.robot === robot
                  return (
                    <td key={role} className={cx('cc-session__cell', fresh && 'is-fresh', (isChosen || isActive) && 'is-chosen')}>
                      <span className="cc-session__count">
                        <StatusMark status={short ? 'failed' : 'done'} size={13} />
                        {count} WP{fresh ? <span className="cc-session__fresh"> · new</span> : null}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy !== null || active !== null || blocked !== null}
                        title={blocked ?? `Record ${robot}’s ${info.title.toLowerCase()}`}
                        onClick={() => {
                          setError(null)
                          setChosen({ phase, robot })
                        }}
                      >
                        Record
                      </Button>
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>

      {active || chosen || recording ? (
        <Recorder
          chosen={active ? { phase: active.phase, robot: active.robot } : chosen}
          recording={recording}
          before={(c) => plan?.phases[c.phase].robots[c.robot] ?? 0}
          busy={busy}
          onStart={(c, append) => act('start', () => recordStart(c.phase, c.robot, append), () => setChosen(null))}
          onKey={(key) => act(key, () => recordKey(key))}
          onClose={() => setChosen(null)}
        />
      ) : null}
      {error ? <p className="cc-session__error">{error}</p> : null}

      <ConfirmModal
        open={confirmDiscard}
        title="Discard these routes?"
        confirmLabel="Discard"
        tone="danger"
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false)
          act('discard', discardSession)
        }}
      >
        demo/waypoints/{session.plan} is deleted, with everything recorded into it. The plans before it stay as they are.
      </ConfirmModal>
    </Panel>
  )
}

interface RecorderProps {
  chosen: Choice | null
  recording: RecordingFacts | null
  before: (choice: Choice) => number
  busy: string | null
  onStart: (choice: Choice, append: boolean) => void
  onKey: (key: RecorderKey) => void
  onClose: () => void
}

/** One robot and phase: start it, then fleet_management.py's keys as buttons */
function Recorder({ chosen, recording, before, busy, onStart, onKey, onClose }: RecorderProps) {
  const [append, setAppend] = useState(false)
  const running = recording && (recording.state === 'starting' || recording.state === 'recording') ? recording : null
  // Not started: the robot and phase chosen in the grid
  if (!running && chosen) {
    const info = PHASE_INFO[chosen.phase]
    const has = before(chosen)
    return (
      <section className="cc-recorder" aria-label="Recorder">
        <h3 className="cc-recorder__title">
          Record {chosen.robot}’s {info.title.toLowerCase()}
        </h3>
        <p className="cc-recorder__lead">{info.needs}.</p>
        {!info.single && has ? (
          <label className="cc-recorder__append">
            <input type="checkbox" checked={append} onChange={(e) => setAppend(e.target.checked)} />
            Add after its {has} waypoint{has === 1 ? '' : 's'} (APPEND=1), instead of replacing them
          </label>
        ) : null}
        <div className="cc-recorder__keys">
          <Button variant="primary" disabled={busy !== null} onClick={() => onStart(chosen, !info.single && append)}>
            {busy === 'start' ? 'Starting…' : 'Start recording'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Not now
          </Button>
        </div>
      </section>
    )
  }
  if (!running) {
    // How the last one ended
    if (!recording) return null
    return (
      <section className={cx('cc-recorder', 'is-over')} aria-label="Recorder">
        <p className={cx('cc-recorder__result', recording.state === 'saved' ? 'cc-tone--ok' : recording.state === 'failed' ? 'cc-tone--fault' : 'cc-tone--muted')}>
          {recording.state === 'saved' ? 'Saved' : recording.state === 'failed' ? 'Could not record' : 'Not saved'} · {recording.robot}’s{' '}
          {PHASE_INFO[recording.phase].title.toLowerCase()}
          {recording.message ? `: ${recording.message.text}` : ''}
        </p>
      </section>
    )
  }
  const info = PHASE_INFO[running.phase]
  const has = before(running)
  const n = running.waypoints.length
  const savable = canSave(running.phase, n, has, running.append)
  const taking = running.state === 'recording'
  return (
    <section className="cc-recorder is-live" aria-label="Recorder">
      <h3 className="cc-recorder__title">
        Recording {running.robot}’s {info.title.toLowerCase()}
        {running.append ? ` after its ${has} waypoint${has === 1 ? '' : 's'}` : ''}
      </h3>
      <p className="cc-recorder__lead">
        {taking ? `Drive ${running.robot} with its controller to each waypoint, then Record waypoint. ${info.needs}.` : 'Starting demo/record_waypoints.sh…'}
      </p>
      <code className="cc-recorder__cmd">$ {running.command}</code>
      <ol className="cc-recorder__wps" aria-label="Waypoints recorded">
        {running.waypoints.map((w, i) => (
          <li key={i}>
            <span className="cc-recorder__wp">WP{(running.append ? has : 0) + i + 1}</span>x {w.x.toFixed(2)} · y {w.y.toFixed(2)} · {Math.round((w.yaw * 180) / Math.PI)}°
          </li>
        ))}
        {!n ? <li className="cc-recorder__none">None yet</li> : null}
      </ol>
      {running.message ? <p className={cx('cc-recorder__msg', `cc-tone--${running.message.tone === 'info' ? 'muted' : running.message.tone}`)}>{running.message.text}</p> : null}
      <div className="cc-recorder__keys">
        <Button variant="primary" disabled={!taking || busy !== null || (info.single && n >= 1)} onClick={() => onKey('record')}>
          Record waypoint
        </Button>
        <Button variant="secondary" disabled={!taking || busy !== null || !n} onClick={() => onKey('undo')}>
          Undo
        </Button>
        <Button variant="ghost" disabled={!taking || busy !== null || !n} onClick={() => onKey('clear')}>
          Clear
        </Button>
        <span className="cc-recorder__spacer" />
        <Button
          variant={savable ? 'primary' : 'secondary'}
          disabled={!taking || busy !== null || !savable}
          title={savable ? `Save to ${running.phase}.json` : info.single ? 'Record its one waypoint first' : `${info.min} waypoints at least`}
          onClick={() => onKey('save')}
        >
          Save
        </Button>
        <Button variant="ghost" disabled={busy !== null} onClick={() => onKey('cancel')}>
          Cancel
        </Button>
      </div>
    </section>
  )
}
