// The M20 operator dashboard: Open-RMF's dashboard (rmf-dashboard-framework, the one
// rmf-web ships) with our mission panels added as micro-apps. One page for everything:
// Open-RMF's map, robots and tasks, and the mission (phase, prompts, verdicts, STOP ALL).
//
// Data: Open-RMF's panels read the rmf-web API server (:8000); ours read the M20 hub
// (m20_rmf ui, which also serves this page on :8080, websocket :8081).

import '@fontsource/roboto/300.css';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';

import { Button } from '@mui/material';
import ReactDOM from 'react-dom/client';
import {
  InitialWindow,
  LocallyPersistentWorkspace,
  MicroAppManifest,
  RmfDashboard,
  Workspace,
} from 'rmf-dashboard-framework/components';
import { createMapApp, robotsApp, tasksApp } from 'rmf-dashboard-framework/micro-apps';
import { StubAuthenticator } from 'rmf-dashboard-framework/services';

// Built from inside rmf-dashboard-framework (build.sh), so its internals are reachable;
// the map's layer switches are not part of its public API.
import { AppEvents } from '../../src/components/app-events';
import { fleetApp, missionApp } from './apps';
import { send, useHub } from './hub';

const host = window.location.hostname;       // works from a tablet on the Wi-Fi too

const mapApp = createMapApp({
  attributionPrefix: 'M20 fleet',
  defaultMapLevel: 'L1',
  defaultRobotZoom: 20,
  defaultZoom: 45,
});

// Grid: 12 columns; heights in rows of the framework's workspace (6 fill the screen).
// Show the site's places and their names on the map (Open-RMF hides them by default).
// The map replaces its layer settings with this whole set when it mounts.
AppEvents.disabledLayers.next({
  'Pickup & Dropoff waypoints': false,
  'Pickup & Dropoff labels': true,
  Waypoints: false,
  'Waypoint labels': false,
  'Doors & Lifts': false,
  'Doors labels': true,
  Robots: false,
  'Robots labels': false,
  Trajectories: false,
});

const operations: InitialWindow[] = [
  { layout: { x: 0, y: 0, w: 4, h: 4 }, microApp: missionApp },
  { layout: { x: 0, y: 4, w: 4, h: 2 }, microApp: fleetApp },
  { layout: { x: 4, y: 0, w: 8, h: 6 }, microApp: mapApp },
];
const robots: InitialWindow[] = [
  { layout: { x: 0, y: 0, w: 7, h: 3 }, microApp: robotsApp },
  { layout: { x: 0, y: 3, w: 7, h: 3 }, microApp: fleetApp },
  { layout: { x: 7, y: 0, w: 5, h: 6 }, microApp: mapApp },
];
const tasks: InitialWindow[] = [
  { layout: { x: 0, y: 0, w: 7, h: 6 }, microApp: tasksApp },
  { layout: { x: 7, y: 0, w: 5, h: 6 }, microApp: mapApp },
];
const registry: MicroAppManifest[] = [missionApp, fleetApp, mapApp, robotsApp, tasksApp];

// Always on screen, on every tab: stops every robot where it stands (no drop) and ends the
// mission. The same stop as `m20 stop` and Ctrl-C in the mission pane.
function StopAll() {
  const { connected, busy } = useHub();
  return (
    <Button
      variant="contained"
      color="error"
      size="large"
      disabled={!connected}
      title="Stop every robot where it stands (no drop) and end the mission"
      onClick={() => send({ cmd: 'stop', robot: 'all' })}
      sx={{
        position: 'fixed',
        right: 24,
        bottom: 24,
        zIndex: 2000,
        px: 4,
        py: 1.5,
        fontSize: 18,
        fontWeight: 800,
        letterSpacing: '.06em',
        opacity: busy.size ? 0.7 : 1,
        boxShadow: 6,
      }}
    >
      STOP ALL
    </Button>
  );
}

export default function App() {
  return (
    <>
      <RmfDashboard
        apiServerUrl={`http://${host}:8000`}
        trajectoryServerUrl={`ws://${host}:8006`}
        authenticator={new StubAuthenticator()}
        helpLink="https://osrf.github.io/ros2multirobotbook/rmf-core.html"
        reportIssueLink="https://github.com/open-rmf/rmf-web/issues"
        resources={{ fleets: {}, logos: { header: '/resources/defaultLogo.png' } }}
        tasks={{
          allowedTasks: [{ taskDefinitionId: 'patrol' }, { taskDefinitionId: 'custom_compose' }],
          pickupZones: [],
          cartIds: [],
        }}
        tabs={[
          { name: 'Operations', route: '', element: <Workspace initialWindows={operations} /> },
          { name: 'Robots', route: 'robots', element: <Workspace initialWindows={robots} /> },
          { name: 'Tasks', route: 'tasks', element: <Workspace initialWindows={tasks} /> },
          {
            name: 'Custom',
            route: 'custom',
            element: (
              <LocallyPersistentWorkspace
                defaultWindows={[]}
                allowDesignMode
                appRegistry={registry}
                storageKey="m20-custom-workspace"
              />
            ),
          },
        ]}
      />
      <StopAll />
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />);
