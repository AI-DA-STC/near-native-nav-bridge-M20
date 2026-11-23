import type { Pt, SiteMap } from '../mission-stream'

/* The arena of the brief (map frame, metres): the walls and zones are placeholders until the backend serves the SLAM
 * grid; the routes are the ones recorded in demo/waypoints/*.json, rounded as the brief gives them. */

const ARENA: Pt[] = [[-4.9, 0.8], [12, 0.8], [12, -11.9], [-4.9, -11.9]]

export const SITE: SiteMap = {
  extent: { xMin: -5, xMax: 12, yMin: -12, yMax: 1 },
  occupancy: null,
  box: { x: 4.0286, y: -1.7152, yaw: -2.2, w: 0.6, h: 0.38 },
  free: [ARENA],
  walls: [
    { points: ARENA, closed: true },
    { rect: [8.4, -10.6, 2.4, 0.6] },
    { rect: [10.4, -8.9, 0.6, 2.6] },
    { rect: [2, -4.6, 0.5, 0.5] },
    { rect: [-1, -10.6, 0.5, 0.5] },
    { rect: [-4.6, -10.4, 1, 1] },
  ],
  // zone 1 to the south-east, zone 2 to the east, zone 3 to the north around the box
  zones: [
    { id: 'z1', label: 'ZONE 1', points: [[2.2, -10.3], [7.6, -10.3], [7.6, -6.7], [2.2, -6.7]] },
    { id: 'z2', label: 'ZONE 2', points: [[3.7, -5.8], [11.8, -5.8], [11.8, 0.3], [5.6, 0.3], [5.6, -3.3], [3.7, -3.3]] },
    { id: 'z3', label: 'ZONE 3', points: [[-0.3, -3.2], [5.3, -3.2], [5.3, 0.5], [-0.3, 0.5]] },
  ],
  routes: {
    patrol: {
      r1: [[-3.8, -0.62], [-2.28, -0.77], [-2.36, -3.38], [-4.19, -3.32]],
      r2: [[-1.23, -4.53], [-1.4, -7.05], [-3.34, -7.06], [-3.49, -4.65]],
      r3: [[-0.16, -6.91], [3.12, -6.86], [3.25, -9.31], [1, -9.12]],
    },
    // all facing +x
    slots: [
      { n: 1, robot: 'r1', x: -0.16, y: -6.93, yaw: 0 },
      { n: 2, robot: 'r2', x: 0.52, y: -5.55, yaw: 0 },
      { n: 3, robot: 'r3', x: -0.07, y: -4.34, yaw: 0 },
    ],
    sweep: {
      r1: [[2.76, -9.19], [5.99, -9.64], [6.89, -7.4]],
      r2: [[4.32, -5.06], [7.91, -3.56], [11.21, -0.65]],
      // ends next to the box
      r3: [[0.41, -2.6], [0.89, -0.81], [3.92, -0.62]],
    },
    cordon: [
      { robot: 'r1', x: 5.36, y: -3.85 },
      { robot: 'r2', x: 6.73, y: -1.2 },
    ],
    watch: { robot: 'r3', x: 6.14, y: -0.17 },
    // the ALOHA waits north-west of the box: the cordon points sit 3 m east of it, where the brief first put it
    aloha: {
      start: [-0.95, -2.25],
      path: [[-0.95, -2.25], [-0.6, -0.4], [1, 0.2], [2.6, 0.1], [3.7, -0.15], [4.07, -0.5]],
      dock: { x: 4.07, y: -0.5, yaw: -94 },
    },
  },
}

/** The box itself: centre and footprint, metres */
export const BOX = { x: 4.03, y: -1.72, w: 0.6, h: 0.38 }
