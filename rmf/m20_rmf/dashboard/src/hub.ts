// Connection to the M20 hub (m20_rmf ui): the fleet view (modes, mission, prompts,
// inspections, log) comes in, operator commands go out. One shared websocket for all
// panels; reconnects by itself. The hub's websocket is on the page's port + 1.

import { useSyncExternalStore } from 'react';

export interface Robot {
  id: string;
  mode: string;
  color: string;
  detail: string;
  battery: number | null;
  warning?: string;
  task: string | null;
}

export interface Waiting {
  event: string;
  prompt: string;
  label: string;
  seconds: number | null;
  since: number;
}

export interface Signal {
  event: string;
  label?: string;
  data?: Record<string, unknown>;
}

export interface Mission {
  name?: string;
  state?: string;
  running?: boolean;
  phase?: string;
  started?: number;
  error?: string;
  reason?: string;
  waiting?: Waiting | null;
  signals?: Signal[];
  used?: string[];
  queued?: string[];
}

export interface Inspection {
  robot: string;
  target: string;
  label: string;
  t: number;
}

export interface FleetView {
  t: number;
  mission: Mission;
  robots: Robot[];
  inspections: Record<string, Inspection>;
  timeline: { t: number; text: string; kind: string }[];
  host?: { up: boolean; busy: boolean };
}

export interface MissionFile {
  file: string;
  name: string;
}

interface State {
  connected: boolean;
  view: FleetView | null;
  missions: MissionFile[];
  error: string;
  busy: Set<number>;
}

let state: State = { connected: false, view: null, missions: [], error: '', busy: new Set() };
const listeners = new Set<() => void>();
let ws: WebSocket | null = null;
let nextId = 1;

function set(changes: Partial<State>) {
  state = { ...state, ...changes };
  listeners.forEach((l) => l());
}

export function hubUrl(): string {
  const port = Number(window.location.port || 80) + 1;
  return `ws://${window.location.hostname}:${port}`;
}

function connect() {
  ws = new WebSocket(hubUrl());
  ws.onopen = () => set({ connected: true, error: '' });
  ws.onclose = () => {
    set({ connected: false });
    setTimeout(connect, 1000);
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'view') set({ view: m.view });
    else if (m.type === 'missions') set({ missions: m.missions });
    else if (m.type === 'reply') {
      const busy = new Set(state.busy);
      busy.delete(m.id);
      set({ busy, error: m.error || '' });
    }
  };
}
connect();

/** Send a command; returns its id (busy until the hub replies). */
export function send(cmd: Record<string, unknown>): number | null {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    set({ error: 'Not connected to the M20 hub: command not sent.' });
    return null;
  }
  const id = nextId++;
  ws.send(JSON.stringify({ ...cmd, id }));
  const busy = new Set(state.busy);
  busy.add(id);
  set({ busy });
  return id;
}

export function clearError() {
  set({ error: '' });
}

export function useHub(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
