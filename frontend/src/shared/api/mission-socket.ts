import type { CommandResult, ConnectionStatus, MissionCommand, MissionSnapshot, MissionSource, SiteMap } from './mission-stream'

/* The live mission source: the setup server's /api/mission WebSocket, which turns the robots configured in Setup, the
 * plan in use and demo/run_demo.sh's output into snapshots. While the server is away it tries again every 1 to 5 s. */

type ServerMessage = { type: 'snapshot'; snapshot: MissionSnapshot } | ({ type: 'result'; req: number } & CommandResult)

export function createMissionSocket(url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/mission`): MissionSource {
  let ws: WebSocket | null = null
  let status: ConnectionStatus = 'connecting'
  let snapshot: MissionSnapshot | null = null
  let nextReq = 1
  let retryMs = 1000
  const listeners = new Set<() => void>()
  const answers = new Map<number, (result: CommandResult) => void>()
  const emit = () => listeners.forEach((listener) => listener())

  function open() {
    ws = new WebSocket(url)
    ws.onopen = () => {
      status = 'open'
      retryMs = 1000
      emit()
    }
    ws.onmessage = (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as ServerMessage
      if (message.type === 'snapshot') {
        snapshot = message.snapshot
        emit()
      } else {
        answers.get(message.req)?.({ ok: message.ok, reason: message.reason })
        answers.delete(message.req)
      }
    }
    ws.onclose = () => {
      status = snapshot ? 'closed' : 'connecting'
      for (const answer of answers.values()) answer({ ok: false, reason: 'The setup server went away' })
      answers.clear()
      emit()
      setTimeout(open, retryMs)
      retryMs = Math.min(retryMs * 2, 5000)
    }
  }
  open()

  return {
    kind: 'live',
    status: () => status,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    send: (command: MissionCommand) =>
      new Promise((resolve) => {
        if (ws?.readyState !== WebSocket.OPEN) return resolve({ ok: false, reason: 'Not connected to the setup server' })
        const req = nextReq++
        answers.set(req, resolve)
        ws.send(JSON.stringify({ ...command, req }))
      }),
    siteMap: async (map = 'dogs'): Promise<SiteMap> => {
      const res = await fetch(map === 'aloha' ? '/api/mission/site?map=aloha' : '/api/mission/site', { cache: 'no-store' })
      if (!res.ok) throw new Error(`The site map did not load (${res.status})`)
      return (await res.json()) as SiteMap
    },
  }
}
