import { createBrowserRouter, Navigate, type RouteObject } from 'react-router'
import { FleetHealthPage } from '@/pages/fleet-health'
import { RoutesPage } from '@/pages/routes'
import { SetupPage } from '@/pages/setup'
import { TerminalsPage } from '@/pages/terminals'
import { AppShell } from './layout/AppShell'
import { LandingRoute, MissionRoute } from './layout/FlowRoutes'

/* "/" is the landing page; Launch goes on to the first step not confirmed. Then the operator's way: "/setup" (the
 * robots join and are set up), "/routes" (the mission plan's routes, recorded and picked), "/mission" (the Command
 * center, locked until both are confirmed). "/terminals" shows the setup's terminals at any time, "/fleet-health" the
 * link to each robot and the router (a ping dashboard each). */
export const routes: RouteObject[] = [
  { path: '/', element: <LandingRoute /> },
  {
    element: <AppShell />,
    children: [
      { path: '/setup', element: <SetupPage /> },
      { path: '/routes', element: <RoutesPage /> },
      { path: '/mission', element: <MissionRoute /> },
      { path: '/terminals', element: <TerminalsPage /> },
      { path: '/fleet-health', element: <FleetHealthPage /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]

export const router = createBrowserRouter(routes)
