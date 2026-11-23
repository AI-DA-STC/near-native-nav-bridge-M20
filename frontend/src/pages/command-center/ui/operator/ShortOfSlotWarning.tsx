import { Icon } from '@/shared/ui/Icon'
import { RobotTag } from '@/shared/ui/RobotTag'
import type { ShortOfSlot } from '../../model/operator-turn'
import './ShortOfSlotWarning.css'

/** Above the plan: the dogs the formation left short of their slot. Approving still starts the sweep */
export function ShortOfSlotWarning({ robots }: { robots: ShortOfSlot[] }) {
  if (!robots.length) return null
  const one = robots.length === 1
  return (
    <div className="cc-shortslot" role="note">
      <Icon name="warn" size={14} className="cc-shortslot__icon" />
      <div className="cc-shortslot__body">
        {robots.map((r) => (
          <p key={r.robot} className="cc-shortslot__line">
            <RobotTag robot={r.robot} size="sm" />
            <span>
              {r.outcome === 'timeout' ? 'timed out before' : 'stopped short of'} slot {r.slot}
            </span>
          </p>
        ))}
        <p className="cc-shortslot__detail">
          Formation incomplete. {one ? 'It starts the sweep from where it stopped.' : 'They start the sweep from where they stopped.'}
        </p>
      </div>
    </div>
  )
}
