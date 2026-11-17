import { createBrowserRouter, Navigate, type RouteObject } from 'react-router'
import { CommandCenterPage } from '@/pages/command-center'
import { AppShell } from './layout/AppShell'
import { OperatorStartMission } from './layout/MissionActions'

/** "/" is the Command center; Fleet health, Routes and Log show as disabled tabs until their pages exist */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <CommandCenterPage startControl={<OperatorStartMission />} /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]

export const router = createBrowserRouter(routes)
