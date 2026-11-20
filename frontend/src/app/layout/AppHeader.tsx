import type { ReactNode } from 'react'
import { cx } from '@/shared/lib'
import { Tabs, type TabItem } from '@/shared/ui/Tabs'
import { TelemetryPill, type TelemetryPillProps } from '@/shared/ui/TelemetryPill'
import { Brandmark } from './Brandmark'
import { EStopButton } from './EStopButton'
import { MissionClock } from './MissionClock'
import { StateChip, type MissionState } from './StateChip'
import './AppHeader.css'

export interface AppHeaderProps {
  title?: string
  /** The mission's name, in mono */
  subtitle?: string
  /** Turns the brandmark */
  running?: boolean
  state?: MissionState
  /** Overrides the state chip's word: the setup's own states ("SETTING UP") */
  stateLabel?: string
  stateDetail?: ReactNode
  /** mm:ss */
  clock?: string
  clockLabel?: string
  clockRunning?: boolean
  /** Start mission · Stop mission · Force stop */
  actions?: ReactNode
  /** The E-STOP's action. Without one the header has no E-STOP: Setup and Terminals, where no mission runs. */
  onEStop?: () => void
  tabs?: TabItem[]
  tab?: string
  onTab?: (id: string) => void
  pills?: Array<TelemetryPillProps & { id: string }>
  /** The attention chips, in the tab bar between the tabs and the pills */
  attention?: ReactNode
  className?: string
}

/** The header band and the tab bar under it. Fixed at the top; nothing goes right of E-STOP, where there is one. */
export function AppHeader({
  title = 'Command Center',
  subtitle,
  running = false,
  state = 'ready',
  stateLabel,
  stateDetail,
  clock,
  clockLabel,
  clockRunning,
  actions,
  onEStop,
  tabs,
  tab,
  onTab,
  pills = [],
  attention,
  className,
}: AppHeaderProps) {
  return (
    <header className={cx('cc-header', className)}>
      <div className="cc-header__bar">
        <div className="cc-header__brand">
          <Brandmark running={running} size={30} />
          <div className="cc-header__names">
            <div className="cc-header__title">{title}</div>
            {subtitle ? <div className="cc-header__sub">{subtitle}</div> : null}
          </div>
        </div>
        <StateChip state={state} label={stateLabel} detail={stateDetail} />
        {clock ? <MissionClock time={clock} label={clockLabel} running={clockRunning ?? running} /> : null}
        <div className="cc-header__spacer" />
        {actions ? <div className="cc-header__actions">{actions}</div> : null}
        {onEStop ? <EStopButton onClick={onEStop} /> : null}
      </div>
      {tabs || pills.length || attention ? (
        <div className="cc-header__nav">
          {tabs ? <Tabs items={tabs} value={tab} onChange={onTab} /> : <span />}
          {attention ? <div className="cc-header__attn">{attention}</div> : null}
          <div className="cc-header__pills">
            {pills.map(({ id, ...pill }) => (
              <TelemetryPill key={id} {...pill} />
            ))}
          </div>
        </div>
      ) : null}
    </header>
  )
}
