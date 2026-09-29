// Our panels as rmf-dashboard-framework micro-apps, next to Open-RMF's own. (The framework
// wants the manifest in a different module from the lazily loaded component.)

import { createMicroApp } from 'rmf-dashboard-framework/components';

export const missionApp = createMicroApp('M20Mission', 'Mission', () => import('./mission-panel'), () => ({}));

export const fleetApp = createMicroApp('M20Fleet', 'Fleet', () => import('./fleet-panel'), () => ({}));
