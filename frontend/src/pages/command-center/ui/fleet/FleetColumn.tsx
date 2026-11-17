import type { MissionSnapshot } from '@/shared/api'
import { ROBOT_KEYS, type RobotKey } from '@/shared/config'
import { robotCardOf } from '../../model/robot-state'
import { RobotCard } from './RobotCard'

export interface FleetColumnProps {
  snap: MissionSnapshot
  selected: RobotKey | null
  /** Selecting a card highlights the robot on the map */
  onSelect: (robot: RobotKey) => void
  compact?: boolean
}

/** The four robots, in the fleet's order: the dogs share one layout, the ALOHA's adds docking and arms. A card shows
 * the distance to its goal and its speed only while the robot drives to one. */
export function FleetColumn({ snap, selected, onSelect, compact = false }: FleetColumnProps) {
  return (
    <div className="cc-ccpage__fleet" aria-label="Fleet">
      {ROBOT_KEYS.map((robot) => {
        const card = robotCardOf(robot, snap)
        return <RobotCard key={robot} card={card} selected={selected === robot} onClick={() => onSelect(robot)} compact={compact || card.goal === null} />
      })}
    </div>
  )
}
