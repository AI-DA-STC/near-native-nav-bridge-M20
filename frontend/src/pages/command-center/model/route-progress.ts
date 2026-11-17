import type { RouteFacts } from '@/shared/api'

/** How far along its leg a robot is, 0–1, from the navigation feedback */
export function legFraction(route: RouteFacts): number {
  if (route.state === 'finished') return 1
  if (!route.legLength || route.distanceRemaining === null) return 0
  return Math.max(0, Math.min(1, 1 - route.distanceRemaining / route.legLength))
}

/** Waypoints reached plus the leg under way, out of the route's total: 1.55 of 3 */
export function waypointsDone(route: RouteFacts): number {
  return route.state === 'finished' ? route.total : route.reached + legFraction(route)
}

/** 0–1 over the whole route */
export function routeProgress(route: RouteFacts | null): number {
  return route && route.total ? waypointsDone(route) / route.total : 0
}
