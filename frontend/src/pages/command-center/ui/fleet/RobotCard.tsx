import { robotOf } from '@/shared/config'
import { cssVars, cx, formatNumber, type Tone } from '@/shared/lib'
import { Icon } from '@/shared/ui/Icon'
import { ProgressBar } from '@/shared/ui/ProgressBar'
import { RobotGlyph } from '@/shared/ui/RobotGlyph'
import type { RobotCardView } from '../../model/robot-state'
import './RobotCard.css'

interface PipsProps {
  label: string
  n: number
  value: number
  state: 'active' | 'done' | 'failed'
  /** Marks a step with the camera: pose 3, the lid open for the photo */
  marks?: Record<number, string>
  detail: string
  tone?: 'fault'
}

function Pips({ label, n, value, state, marks = {}, detail, tone }: PipsProps) {
  return (
    <div className={cx('cc-pips', tone && `cc-pips--${tone}`)}>
      <span className="cc-pips__label">{label}</span>
      <span className="cc-pips__row">
        {Array.from({ length: n }, (_, i) => {
          const k = i + 1
          const s = state === 'done' || k < value ? 'done' : k === value ? (state === 'failed' ? 'failed' : 'current') : 'todo'
          return (
            <span key={k} className={cx('cc-pip', `is-${s}`, marks[k] && 'has-mark')} title={marks[k] ? `${label} ${k}: ${marks[k]}` : `${label} ${k}`}>
              {marks[k] ? <Icon name="camera" size={9} /> : null}
            </span>
          )
        })}
      </span>
      <span className="cc-pips__detail">{detail}</span>
    </div>
  )
}

export interface RobotCardProps {
  card: RobotCardView
  selected?: boolean
  /** Selecting a card highlights the robot on the map */
  onClick?: () => void
  compact?: boolean
  className?: string
}

/** One robot of the fleet: identity in its colour, state word in its status colour, two different questions */
export function RobotCard({ card, selected = false, onClick, compact = false, className }: RobotCardProps) {
  const r = robotOf(card.robot)
  const Tag = onClick ? 'button' : 'article'
  const tone: Tone = card.tone
  // the bar draws the robot's own route progress while it runs fine, its status otherwise
  const barTone = tone === 'ok' ? r.key : tone === 'neutral' || tone === 'unknown' || tone === 'blocked' ? 'blocked' : tone
  const { docking, arms, pose } = card
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      className={cx('cc-rcard', `cc-rcard--${tone}`, selected && 'is-selected', compact && 'is-compact', className)}
      style={cssVars({ '--rc': r.color })}
      onClick={onClick}
      aria-pressed={onClick ? selected : undefined}
    >
      <span className="cc-rcard__rail" aria-hidden="true" />
      <div className="cc-rcard__head">
        <RobotGlyph robot={r.key} heading={pose?.yaw ?? 0} size={18} dim={!pose} />
        <span className="cc-rcard__name">
          <b>{r.label}</b>
          {r.id ? <span className="cc-rcard__id">· {r.id}</span> : null}
        </span>
        <span className={cx('cc-rcard__state', `cc-tone--${tone}`)}>{card.word}</span>
      </div>
      {card.task ? <div className="cc-rcard__task">{card.task}</div> : null}
      {!compact ? (
        <div className="cc-rcard__figs">
          <div className="cc-rcard__fig">
            <span className="cc-rcard__big cc-num">{card.dist !== null ? formatNumber(card.dist, 2) : '—'}</span>
            <span className="cc-rcard__unit">m{card.goal ? ` to ${card.goal}` : ' to goal'}</span>
          </div>
          <div className="cc-rcard__fig cc-rcard__fig--r">
            <span className="cc-rcard__mid cc-num">{card.speed !== null ? formatNumber(card.speed, 2) : '—'}</span>
            <span className="cc-rcard__unit">m/s</span>
          </div>
        </div>
      ) : null}
      {card.progress ? (
        <ProgressBar
          value={card.progress.value}
          max={card.progress.max}
          segments={card.progress.max <= 6 ? card.progress.max : 0}
          tone={barTone}
          label={`${r.label} waypoint progress`}
        />
      ) : null}
      {docking ? (
        <Pips
          label="DOCK"
          n={docking.of}
          value={docking.step}
          state={docking.state}
          tone={docking.state === 'failed' ? 'fault' : undefined}
          detail={docking.detail ?? (docking.state === 'done' ? 'docked' : docking.state === 'failed' ? 'failed' : docking.step ? `${docking.step}/${docking.of}` : 'not started')}
        />
      ) : null}
      {arms ? (
        <Pips
          label="ARMS"
          n={arms.of}
          value={arms.pose}
          state={arms.state}
          marks={{ 3: 'lid open, photo' }}
          detail={arms.detail ?? (arms.pose ? `${arms.pose}/${arms.of}${arms.pose === 3 ? ' · lid open' : ''}` : 'folded')}
        />
      ) : null}
      <div className="cc-rcard__foot">
        <span className="cc-mono cc-num cc-rcard__pose">
          {pose ? `x ${formatNumber(pose.x)}  y ${formatNumber(pose.y)}  θ ${formatNumber(Math.round(pose.yaw), 0)}°` : 'no position'}
        </span>
        {card.updated ? <span className="cc-rcard__upd cc-mono">{card.updated}</span> : null}
        <span className="cc-rcard__slot" title="Battery: not wired yet">
          <Icon name="battery" size={13} />—
        </span>
        <span className="cc-rcard__slot" title="Wi-Fi link quality: not wired yet">
          <Icon name="link" size={13} />—
        </span>
      </div>
    </Tag>
  )
}
