import { useState } from 'react'
import type { PlanSummary, RecorderKey, RecordingFacts, RouteSessionFacts, RvizState, RvizWhich, SetupResult, SetupSnapshot } from '@/shared/api'
import { cx } from '@/shared/lib'
import { Button } from '@/shared/ui/Button'
import { ConfirmModal } from '@/shared/ui/ConfirmModal'
import { Panel } from '@/shared/ui/Panel'
import { RobotTag } from '@/shared/ui/RobotTag'
import { StatusMark } from '@/shared/ui/StatusMark'
import { discardSession, finishSession, openRviz, recordKey, recordStart } from '../api/route-commands'
import { PHASES, PHASE_INFO, canSave, lobbyColumns, planWhen, recordBlocked, robotName, rvizOf, sitsOut, type Choice } from '../model/plans'
import './SessionPanel.css'

export interface SessionPanelProps {
  snapshot: SetupSnapshot
  session: RouteSessionFacts
  /** The session's plan, as recorded so far */
  plan: PlanSummary | null
  /** The robot and phase picked in the grid, not recording yet */
  chosen: Choice | null
  onChoose: (choice: Choice | null) => void
}

/** A recording session: each phase's waypoints for every robot added in Setup, inherited from the plan it started from
 * or recorded now, and the recorder for one robot and phase at a time */
export function SessionPanel({ snapshot, session, plan, chosen, onChoose }: SessionPanelProps) {
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
  const columns = lobbyColumns(snapshot)
  const kept = (plan?.recorded.length ?? 0) > 0 || (plan?.leftOut.length ?? 0) > 0
  const current = active ? { phase: active.phase, robot: active.robot } : chosen
  const which = current ? rvizOf(current.phase) : null
  return (
    <Panel
      className="cc-session"
      title={`New routes · from ${session.basedOn ? planWhen(session.basedOn, false) : 'nothing'}`}
      meta={
        <span className="cc-session__actions">
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirmDiscard(true)}>
            Discard
          </Button>
          <Button
            size="sm"
            variant={kept ? 'primary' : 'secondary'}
            disabled={busy !== null || active !== null}
            title={active ? 'Save or cancel the recording first' : undefined}
            onClick={() => act('finish', finishSession)}
          >
            {kept ? 'Finish session' : 'Close: nothing recorded'}
          </Button>
        </span>
      }
      scroll
    >
      <p className="cc-session__lead">
        Saved as <code>demo/waypoints/{session.plan}</code>, a copy of the plan it started from for the robots added in Setup
        {plan?.leftOut.length ? ` (without ${plan.leftOut.join(', ')})` : ''}: what you record replaces that robot’s waypoints in the phase, or adds to
        them. Drive each robot with its own controller; RViz shows the phase on the map while you record.
      </p>
      {!columns.length ? (
        <p className="cc-session__none">No robot is added yet: add them on Setup, and each one gets its routes here.</p>
      ) : (
        <table className="cc-session__grid">
          <thead>
            <tr>
              <th scope="col">Phase</th>
              {columns.map((c) => (
                <th key={c.id} scope="col">
                  {c.key ? <RobotTag robot={c.key} size="sm" /> : <span className="cc-session__id">{c.id}</span>}
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
                  {columns.map(({ id: robot, key }) => {
                    if (!snapshot.participants[phase].includes(robot)) {
                      return (
                        <td key={robot} className="cc-session__none">
                          {sitsOut(phase, key === 'aloha' ? 'aloha' : 'm20')}
                        </td>
                      )
                    }
                    const count = plan?.phases[phase].robots[robot] ?? 0
                    const fresh = plan?.recorded.some((r) => r.phase === phase && r.robot === robot) ?? false
                    const short = info.single ? count !== 1 : count < info.min
                    const blocked = recordBlocked(snapshot, robot)
                    const isCurrent = current?.phase === phase && current.robot === robot
                    return (
                      <td key={robot} className={cx('cc-session__cell', fresh && 'is-fresh', isCurrent && 'is-chosen')}>
                        <span className="cc-session__count">
                          <StatusMark status={short ? 'failed' : 'done'} size={13} />
                          {count} WP{fresh ? <span className="cc-session__fresh"> · new</span> : null}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy !== null || active !== null || blocked !== null}
                          title={blocked ?? `Record ${robot}’s ${info.short.toLowerCase()} route`}
                          aria-label={`Record ${robot}: ${info.title}`}
                          onClick={() => {
                            setError(null)
                            onChoose({ phase, robot })
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
      )}

      {current || recording ? (
        <Recorder
          chosen={current}
          recording={recording}
          rviz={which ? { which, state: session.rviz[which] } : null}
          before={(c) => plan?.phases[c.phase].robots[c.robot] ?? 0}
          busy={busy}
          onStart={(c, append) => act('start', () => recordStart(c.phase, c.robot, append), () => onChoose(null))}
          onKey={(key) => act(key, () => recordKey(key))}
          onOpenRviz={(w) => act('rviz', () => openRviz(w))}
          onClose={() => onChoose(null)}
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

const RVIZ_NAME: Readonly<Record<RvizWhich, string>> = { dogs: 'RViz · dogs', aloha: 'RViz · ALOHA' }

interface RecorderProps {
  chosen: Choice | null
  recording: RecordingFacts | null
  /** The RViz the chosen phase is recorded in */
  rviz: { which: RvizWhich; state: RvizState } | null
  before: (choice: Choice) => number
  busy: string | null
  onStart: (choice: Choice, append: boolean) => void
  onKey: (key: RecorderKey) => void
  onOpenRviz: (which: RvizWhich) => void
  onClose: () => void
}

/** One robot and phase: start it, then fleet_management.py's keys as buttons; the waypoints show on the right and in
 * RViz */
function Recorder({ chosen, recording, rviz, before, busy, onStart, onKey, onOpenRviz, onClose }: RecorderProps) {
  const [append, setAppend] = useState(false)
  const running = recording && (recording.state === 'starting' || recording.state === 'recording') ? recording : null
  const rvizLine = rviz ? (
    <p className="cc-recorder__rviz">
      <span className={cx('cc-recorder__rvizstate', `is-${rviz.state}`)}>
        {RVIZ_NAME[rviz.which]} · {rviz.state === 'open' ? 'open' : rviz.state === 'opening' ? 'opening…' : running ? 'closed' : 'opens when you start'}
      </span>
      {rviz.state === 'closed' && running ? (
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => onOpenRviz(rviz.which)}>
          {busy === 'rviz' ? 'Opening…' : 'Open RViz again'}
        </Button>
      ) : null}
    </p>
  ) : null
  // Not started: the robot and phase chosen in the grid
  if (!running && chosen) {
    const info = PHASE_INFO[chosen.phase]
    const has = before(chosen)
    return (
      <section className="cc-recorder" aria-label="Recorder">
        <h3 className="cc-recorder__title">
          Record {chosen.phase === 'aloha' ? 'the ALOHA’s route to the box' : `${chosen.robot} · ${info.title}`}
        </h3>
        <p className="cc-recorder__lead">{info.needs}.</p>
        {!info.single && has ? (
          <label className="cc-recorder__append">
            <input type="checkbox" checked={append} onChange={(e) => setAppend(e.target.checked)} />
            Add after its {has} waypoint{has === 1 ? '' : 's'} (APPEND=1), instead of replacing them
          </label>
        ) : null}
        {rvizLine}
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
          {recording.state === 'saved' ? 'Saved' : recording.state === 'failed' ? 'Could not record' : 'Not saved'} ·{' '}
          {recording.phase === 'aloha' ? PHASE_INFO.aloha.title : `${recording.robot} · ${PHASE_INFO[recording.phase].title}`}
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
  const where = rviz ? RVIZ_NAME[rviz.which] : 'RViz'
  return (
    <section className="cc-recorder is-live" aria-label="Recorder">
      <h3 className="cc-recorder__title">
        Recording {running.phase === 'aloha' ? 'the ALOHA’s route to the box' : `${running.robot} · ${info.title}`}
        {running.append ? ` after its ${has} waypoint${has === 1 ? '' : 's'}` : ''}
      </h3>
      <p className="cc-recorder__lead">
        {taking
          ? `Drive ${robotName(running.robot)} with its controller to each waypoint, then Record waypoint. Or draw a 2D Goal Pose arrow in ${where}: it becomes the next waypoint too. ${info.needs}.`
          : 'Starting demo/record_waypoints.sh…'}
      </p>
      <code className="cc-recorder__cmd">$ {running.command}</code>
      {rvizLine}
      <p className="cc-recorder__count">
        {n ? `${n} waypoint${n === 1 ? '' : 's'} recorded, listed on the right` : 'No waypoint recorded yet'}
      </p>
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
