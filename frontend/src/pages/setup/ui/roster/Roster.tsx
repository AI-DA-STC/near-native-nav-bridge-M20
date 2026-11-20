import { useEffect, useRef, useState } from 'react'
import type { RobotSetupFacts, RobotSuggestion, SetupSnapshot } from '@/shared/api'
import { cssVars, cx } from '@/shared/lib'
import { Button } from '@/shared/ui/Button'
import { Icon } from '@/shared/ui/Icon'
import { RobotTag } from '@/shared/ui/RobotTag'
import { StatusDot } from '@/shared/ui/StatusDot'
import { robotOf } from '@/shared/config'
import { KIND_LABEL, identityOf, isReady, nameOf, rosterSummary, slotStatus, slotsOf } from '../../model/roster'
import alohaArt from './mobile-aloha.webp'
import m20Art from './m20.webp'
import './Roster.css'

export interface RosterProps {
  snapshot: SetupSnapshot
  /** A robot ID, or 'add' */
  selected: string
  onSelect: (slot: string) => void
  /** On to Routes */
  onContinue: () => void
  /** Why the lobby cannot go on yet, or null */
  continueBlocked: string | null
  now: number
}

/** The lobby along the bottom: each robot that joined stands in its slot, whole while it answers, faded when not */
export function Roster({ snapshot, selected, onSelect, onContinue, continueBlocked, now }: RosterProps) {
  const slots = slotsOf(snapshot)
  const joining = useJoining(snapshot.robots)
  const ready = snapshot.robots.filter(isReady).length
  return (
    <section className="cc-roster" aria-labelledby="cc-roster-title">
      <header className="cc-roster__head">
        <h2 className="cc-roster__title" id="cc-roster-title">
          Robots
        </h2>
        <span className="cc-roster__summary">{rosterSummary(snapshot.robots, now)}</span>
        <span className="cc-roster__spacer" />
        <Button
          variant={ready && ready === snapshot.robots.length ? 'primary' : 'secondary'}
          iconRight="chevronRight"
          disabled={continueBlocked !== null}
          title={continueBlocked ?? undefined}
          onClick={onContinue}
        >
          Continue to Routes
        </Button>
      </header>
      <ol className="cc-roster__slots" style={cssVars({ '--slots': slots.length })}>
        {slots.map((slot, i) => (
          <li key={slot.kind === 'robot' ? slot.robot.id : `${slot.kind}-${i}`} className="cc-roster__slot">
            {slot.kind === 'robot' ? (
              <RobotSlot
                robot={slot.robot}
                index={i}
                now={now}
                selected={selected === slot.robot.id}
                joining={joining.has(slot.robot.id)}
                onSelect={() => onSelect(slot.robot.id)}
              />
            ) : slot.kind === 'add' ? (
              <AddSlot index={i} next={slot.next} selected={selected === 'add'} onSelect={() => onSelect('add')} />
            ) : (
              <EmptySlot index={i} />
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}

/** Robots added while the page is open walk in; the ones already there when it opened just stand */
function useJoining(robots: readonly RobotSetupFacts[]): ReadonlySet<string> {
  const known = useRef<Set<string> | null>(null)
  const [joining, setJoining] = useState<ReadonlySet<string>>(new Set())
  const ids = robots.map((r) => r.id).join(' ')
  useEffect(() => {
    const now = new Set(ids ? ids.split(' ') : [])
    const before = known.current
    known.current = now
    if (!before) return
    const added = [...now].filter((id) => !before.has(id))
    if (!added.length) return
    setJoining(new Set(added))
    const timer = setTimeout(() => setJoining(new Set()), 900)
    return () => clearTimeout(timer)
  }, [ids])
  return joining
}

const slotNumber = (index: number) => String(index + 1).padStart(2, '0')

interface RobotSlotProps {
  robot: RobotSetupFacts
  index: number
  now: number
  selected: boolean
  joining: boolean
  onSelect: () => void
}

function RobotSlot({ robot, index, now, selected, joining, onSelect }: RobotSlotProps) {
  const status = slotStatus(robot, now)
  const identity = identityOf(robot)
  return (
    <button
      type="button"
      className={cx('cc-slot', `is-${status.presence}`, selected && 'is-selected', joining && 'is-joining')}
      style={cssVars({ '--rc': identity ? robotOf(identity).color : 'var(--line-strong)' })}
      aria-pressed={selected}
      aria-label={`${nameOf(robot)}, ${KIND_LABEL[robot.kind]} at ${robot.ip}: ${status.word.toLowerCase()}, ${status.detail}`}
      onClick={onSelect}
    >
      <span className="cc-slot__top">
        <span className="cc-slot__no">{slotNumber(index)}</span>
        {identity && identity !== 'aloha' ? <RobotTag robot={identity} showId={false} size="sm" /> : null}
      </span>
      <span className="cc-slot__stage">
        <img className="cc-slot__model" src={robot.kind === 'aloha' ? alohaArt : m20Art} alt="" draggable={false} />
      </span>
      <span className="cc-slot__name">{nameOf(robot)}</span>
      <span className="cc-slot__sub">
        {KIND_LABEL[robot.kind]} · {robot.ip}
      </span>
      <span className={cx('cc-slot__status', `cc-tone--${status.tone}`)}>
        <StatusDot tone={status.tone} pulse={status.pulse} />
        {status.word}
      </span>
      <span className="cc-slot__detail">{status.detail}</span>
      {robot.kind === 'm20' ? (
        <span className="cc-slot__ticks" aria-hidden="true">
          {robot.setup.steps.map((step) => (
            <span key={step.key} className={cx('cc-slot__tick', `is-${step.status}`)} />
          ))}
        </span>
      ) : null}
    </button>
  )
}

function AddSlot({ index, next, selected, onSelect }: { index: number; next: RobotSuggestion | null; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      className={cx('cc-slot', 'cc-slot--add', selected && 'is-selected')}
      aria-pressed={selected}
      aria-label={next ? `Add robot (next: ${nameOf(next)} at ${next.ip}, ${next.presence})` : 'Add robot'}
      onClick={onSelect}
    >
      <span className="cc-slot__top">
        <span className="cc-slot__no">{slotNumber(index)}</span>
      </span>
      <span className="cc-slot__stage">
        <span className="cc-slot__plus">
          <Icon name="plus" size={22} />
        </span>
      </span>
      <span className="cc-slot__name cc-slot__name--add">Add robot</span>
      {next ? (
        <>
          <span className="cc-slot__sub">
            Next: {nameOf(next)} · {next.ip}
          </span>
          <span className={cx('cc-slot__status', next.presence === 'online' ? 'cc-tone--ok' : 'cc-tone--unknown')}>
            <StatusDot tone={next.presence === 'online' ? 'ok' : 'unknown'} />
            {next.presence === 'online' ? 'ONLINE' : next.presence === 'offline' ? 'OFFLINE' : 'CHECKING'}
          </span>
        </>
      ) : (
        <span className="cc-slot__sub">Any robot, by ID and IP</span>
      )}
    </button>
  )
}

function EmptySlot({ index }: { index: number }) {
  return (
    <div className="cc-slot cc-slot--empty" aria-hidden="true">
      <span className="cc-slot__top">
        <span className="cc-slot__no">{slotNumber(index)}</span>
      </span>
      <span className="cc-slot__stage" />
      <span className="cc-slot__sub">Empty</span>
    </div>
  )
}
