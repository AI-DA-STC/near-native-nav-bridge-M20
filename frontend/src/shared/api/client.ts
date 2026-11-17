import { missionSource, type CommandResult, type MissionCommand, type SiteMap } from './mission-stream'

/** Sends one operator command to the mission and resolves with the answer: refused commands say why */
export function sendCommand(command: MissionCommand): Promise<CommandResult> {
  return missionSource().send(command)
}

/** The site's grid, zones and recorded routes: they change only when the waypoints are recorded again */
export function fetchSiteMap(): Promise<SiteMap> {
  return missionSource().siteMap()
}
