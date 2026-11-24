import { missionSource, type CommandResult, type MissionCommand, type SiteMap, type SiteMapKind } from './mission-stream'

/** Sends one operator command to the mission and resolves with the answer: refused commands say why */
export function sendCommand(command: MissionCommand): Promise<CommandResult> {
  return missionSource().send(command)
}

/** The site's grid, zones and recorded routes: they change only when the waypoints are recorded again. The dogs' map,
 * or the ALOHA's own */
export function fetchSiteMap(map: SiteMapKind = 'dogs'): Promise<SiteMap> {
  return missionSource().siteMap(map)
}
