import type { ReactNode } from 'react'
import { robotOf, type RobotKey } from '@/shared/config'
import { cx } from '@/shared/lib'
import { Icon } from '@/shared/ui/Icon'
import { RobotTag } from '@/shared/ui/RobotTag'
import './AttentionChip.css'

export interface AttentionChipProps {
  /** fault only for a system failure; a finding never appears here */
  tone?: 'warn' | 'fault' | 'ok'
  robot?: RobotKey | null
  /** What is wrong, naming the robot by its ID as the scripts do: "Robot 665 not connected" */
  text?: ReactNode
  /** The likely fix, printed after a colon: "is its bridge running?" */
  fix?: ReactNode
  /** Jump to the robot or its health box */
  onClick?: () => void
  children?: ReactNode
  className?: string
}

/** One active warning that names the robot and the likely fix */
export function AttentionChip({ tone = 'warn', robot, text, fix, onClick, children, className }: AttentionChipProps) {
  const Tag = onClick ? 'button' : 'div'
  const r = robot ? robotOf(robot) : null
  // "R3 camera …" already names the robot: keep its colour, drop the repeated label
  const repeats = r !== null && typeof text === 'string' && text.toUpperCase().startsWith(r.label.toUpperCase())
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      className={cx('cc-attn', `cc-attn--${tone}`, className)}
      onClick={onClick}
      role={onClick ? undefined : 'status'}
    >
      <Icon name={tone === 'fault' ? 'fault' : tone === 'ok' ? 'done' : 'warn'} size={14} />
      {r ? <RobotTag robot={r.key} showId={false} showLabel={!repeats} size="sm" /> : null}
      <span className="cc-attn__text">
        {text || children}
        {fix ? <span className="cc-attn__fix">: {fix}</span> : null}
      </span>
    </Tag>
  )
}

export interface AttentionRowProps {
  items?: Array<AttentionChipProps & { id?: string }>
  /** Said when nothing needs attention */
  allClear?: string
  className?: string
}

/** The active warnings in a row; one ok sentence when there are none */
export function AttentionRow({ items = [], allClear = 'every check is green', className }: AttentionRowProps) {
  return (
    <div className={cx('cc-attnrow', className)} role="list">
      {items.length === 0 ? (
        <AttentionChip tone="ok" text={allClear} />
      ) : (
        items.map(({ id, ...item }, i) => <AttentionChip key={id ?? i} {...item} />)
      )}
    </div>
  )
}
