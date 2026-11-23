import type { TabItem } from '@/shared/ui/Tabs'
import type { FlowState } from './flow'

const NOT_BUILT = 'Comes in a later round'
const LOCKED = 'Confirm Setup and Routes first'

/** The screens in the order the operator goes through them. The Command center and Fleet health stay locked until Setup
 * and Routes are confirmed; Fleet health stays disabled after that, until its page exists. */
export function navTabs(flow: FlowState): TabItem[] {
  const locked = !flow.missionOpen
  return [
    { id: '/setup', label: 'Setup' },
    { id: '/routes', label: 'Routes' },
    { id: '/mission', label: 'Command center', disabled: locked, title: locked ? LOCKED : undefined },
    { id: '/terminals', label: 'Terminals' },
    { id: '/fleet-health', label: 'Fleet health', disabled: true, title: locked ? LOCKED : NOT_BUILT },
  ]
}
