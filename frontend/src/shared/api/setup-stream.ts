import { useSyncExternalStore } from 'react'
import type { ClientMessage, PlanRoutes, ServerMessage, SetupCommand, SetupSnapshot } from './setup-protocol'

/* The setup server's stream: one WebSocket to /api/setup on the page's own host (frontend/server, started by
 * `npm run dev`). It carries the snapshots, the commands with their answers, and the terminals' output and input. */

export type SetupConnection = 'connecting' | 'open' | 'closed'

export interface SetupResult {
  ok: boolean
  /** Why the server refused the command, in a sentence */
  error: string | null
}

/** One terminal's output and input, for a terminal view */
export interface TerminalStream {
  /** Calls `write` with the scrollback (replay) then with what the terminal prints; returns the detach */
  attach(write: (data: string, replay: boolean) => void): () => void
  input(data: string): void
  resize(cols: number, rows: number): void
}

export interface SetupSource {
  status(): SetupConnection
  subscribe(onChange: () => void): () => void
  getSnapshot(): SetupSnapshot | null
  send(command: SetupCommand): Promise<SetupResult>
  /** The same stream object for the same session, so a view can depend on it */
  terminal(session: string): TerminalStream
  /** A plan's waypoints, for its preview */
  planRoutes(plan: string): Promise<PlanRoutes>
}

const NOWHERE: TerminalStream = { attach: () => () => undefined, input: () => undefined, resize: () => undefined }

/** Until connectSetup(): connecting forever, which is what a test that never uses the setup sees */
function idleSource(): SetupSource {
  return {
    status: () => 'connecting',
    subscribe: () => () => undefined,
    getSnapshot: () => null,
    send: async () => ({ ok: false, error: 'Not connected to the setup server' }),
    terminal: () => NOWHERE,
    planRoutes: () => Promise.reject(new Error('Not connected to the setup server')),
  }
}

let source: SetupSource = idleSource()

/** Connects the app to its setup source, once, before the first render */
export function connectSetup(next: SetupSource): void {
  source = next
}

export function setupSource(): SetupSource {
  return source
}

/** The latest snapshot, or null until the first one arrives */
export function useSetupSnapshot(): SetupSnapshot | null {
  const s = source
  return useSyncExternalStore(s.subscribe, s.getSnapshot, s.getSnapshot)
}

export function useSetupConnection(): SetupConnection {
  const s = source
  return useSyncExternalStore(s.subscribe, s.status, s.status)
}

export function sendSetupCommand(command: SetupCommand): Promise<SetupResult> {
  return source.send(command)
}

export function terminalStream(session: string): TerminalStream {
  return source.terminal(session)
}

export function fetchPlanRoutes(plan: string): Promise<PlanRoutes> {
  return source.planRoutes(plan)
}

/** The WebSocket source. While the server is away it tries again every 1 to 5 s; the terminals it had open come back
 * with their scrollback. */
export function createSetupSocket(url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/setup`): SetupSource {
  let ws: WebSocket | null = null
  let status: SetupConnection = 'connecting'
  let snapshot: SetupSnapshot | null = null
  let nextReq = 1
  let retryMs = 1000
  const listeners = new Set<() => void>()
  const answers = new Map<number, (result: SetupResult) => void>()
  const writers = new Map<string, Set<(data: string, replay: boolean) => void>>()
  const streams = new Map<string, TerminalStream>()

  const emit = () => listeners.forEach((listener) => listener())
  const post = (message: ClientMessage) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
  }

  function open() {
    ws = new WebSocket(url)
    ws.onopen = () => {
      status = 'open'
      retryMs = 1000
      for (const session of writers.keys()) post({ type: 'term-subscribe', session })
      emit()
    }
    ws.onmessage = (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as ServerMessage
      if (message.type === 'snapshot') {
        snapshot = message.snapshot
        emit()
      } else if (message.type === 'term-output') {
        writers.get(message.session)?.forEach((write) => write(message.data, message.replay))
      } else {
        answers.get(message.req)?.({ ok: message.ok, error: message.error })
        answers.delete(message.req)
      }
    }
    ws.onclose = () => {
      status = snapshot ? 'closed' : 'connecting'
      for (const answer of answers.values()) answer({ ok: false, error: 'The setup server went away' })
      answers.clear()
      emit()
      setTimeout(open, retryMs)
      retryMs = Math.min(retryMs * 2, 5000)
    }
  }
  open()

  return {
    status: () => status,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    send: (command) =>
      new Promise((resolve) => {
        if (ws?.readyState !== WebSocket.OPEN) return resolve({ ok: false, error: 'Not connected to the setup server' })
        const req = nextReq++
        answers.set(req, resolve)
        post({ ...command, req })
      }),
    terminal: (session) => {
      const known = streams.get(session)
      if (known) return known
      const stream: TerminalStream = {
        attach: (write) => {
          let set = writers.get(session)
          if (!set) {
            set = new Set()
            writers.set(session, set)
            post({ type: 'term-subscribe', session })
          }
          set.add(write)
          return () => {
            set.delete(write)
            if (set.size) return
            writers.delete(session)
            post({ type: 'term-unsubscribe', session })
          }
        },
        input: (data) => post({ type: 'term-input', session, data }),
        resize: (cols, rows) => post({ type: 'term-resize', session, cols, rows }),
      }
      streams.set(session, stream)
      return stream
    },
    planRoutes: async (plan) => {
      const res = await fetch(`${location.origin}/api/plans/${encodeURIComponent(plan)}`)
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `No plan ${plan}`)
      return (await res.json()) as PlanRoutes
    },
  }
}
