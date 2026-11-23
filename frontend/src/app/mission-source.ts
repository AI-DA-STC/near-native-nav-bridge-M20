import { connectMission, createMissionSocket } from '@/shared/api'

/* Where the app's mission snapshots come from, connected once before the first render: the setup server's live
 * /api/mission, which follows the robots configured in Setup, the plan in use and demo/run_demo.sh. (The scenario
 * replay of the design brief is now the tests' fixture only.) */

connectMission(createMissionSocket())
