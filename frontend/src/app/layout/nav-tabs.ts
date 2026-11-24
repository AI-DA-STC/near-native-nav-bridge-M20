import type { TabItem } from '@/shared/ui/Tabs'
import type { FlowState } from './flow'

const LOCKED = 'Confirm Setup and Routes first'

/** The screens in the order the operator goes through them. The Command center stays locked until Setup and Routes are
 * confirmed; Terminals and Fleet health (the robots' links, pinged from the start) are open at any time. */
export function navTabs(flow: FlowState): TabItem[] {
  const locked = !flow.missionOpen
  return [
    { id: '/setup', label: 'Setup' },
    { id: '/routes', label: 'Routes' },
    { id: '/mission', label: 'Command center', disabled: locked, title: locked ? LOCKED : undefined },
    { id: '/terminals', label: 'Terminals' },
    { id: '/fleet-health', label: 'Fleet health' },
  ]
}
