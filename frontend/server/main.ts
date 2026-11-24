import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { SetupHub } from './setup-hub.ts'

/* The Command Center on this workstation: the page and the setup server in one process, on one port.
 *   npm run dev    the page from Vite (hot reload) and the setup server
 *   npm start      the built page (npm run build) and the setup server
 * It listens on 127.0.0.1 only, because the setup server hands out shells on the robots and on this workstation.
 * HOST=0.0.0.0 opens it to the network: anyone who can reach the port then gets those shells.
 * PLANS_DIR moves the plans (demo/waypoints); MISSION_UNLOCKED=1 opens the Command center without Setup and Routes. */

const dev = process.argv.includes('--dev')
const host = process.env.HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? 5173)
const frontendRoot = fileURLToPath(new URL('..', import.meta.url))
const packageRoot = resolve(frontendRoot, '..')

const storeFile = process.env.SETUP_ROBOTS_FILE ?? join(frontendRoot, 'server', 'robots.json')
const plansDir = process.env.PLANS_DIR ? resolve(process.env.PLANS_DIR) : join(packageRoot, 'demo', 'waypoints')
const hub = new SetupHub({ packageRoot, storeFile, plansDir, unlocked: process.env.MISSION_UNLOCKED === '1', missionScript: process.env.MISSION_SCRIPT })

const server = createServer()
const sockets = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 })

/** A browser page from another site must not reach the setup server: its Origin has to be this server */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname
  if (path !== '/api/setup' && path !== '/api/mission') return // Vite's hot reload has its own
  if (!sameOrigin(req)) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    return
  }
  sockets.handleUpgrade(req, socket, head, (ws) => (path === '/api/mission' ? hub.mission.connect(ws) : hub.connect(ws)))
})

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon',
}

function serveFile(res: ServerResponse, file: string | null): void {
  if (!file || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
    return
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  createReadStream(file).pipe(res)
}

/** The Command center's files: GET /api/mission/site (the dogs' map, from the plan in use; ?map=aloha the ALOHA's own),
 * /api/mission/map.png and /api/mission/aloha-map.png (the dogs' and the ALOHA's SLAM grids), /api/mission/image?path= (a detection or contents photo, from demo/detections only),
 * /api/mission/camera/<key>.jpg (a robot camera's latest frame). True when it answered. */
function serveMission(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (req.method !== 'GET' || !url.pathname.startsWith('/api/mission/')) return false
  if (url.pathname === '/api/mission/site') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(url.searchParams.get('map') === 'aloha' ? hub.mission.alohaSite() : hub.mission.site()))
  } else if (url.pathname === '/api/mission/map.png') serveFile(res, hub.mission.gridFile())
  else if (url.pathname === '/api/mission/aloha-map.png') serveFile(res, hub.mission.alohaGridFile())
  else if (url.pathname === '/api/mission/image') serveFile(res, hub.mission.imageFile(url.searchParams.get('path') ?? ''))
  else if (/^\/api\/mission\/camera\/[a-z0-9-]+\.jpg$/.test(url.pathname)) serveFile(res, hub.mission.cameraFile(url.pathname.slice(20, -4)))
  else serveFile(res, null)
  return true
}

/** GET /api/plans/<id>: a plan's waypoints, for its preview. True when it answered. */
function servePlans(req: IncomingMessage, res: ServerResponse): boolean {
  if (serveMission(req, res)) return true
  const path = new URL(req.url ?? '/', 'http://localhost').pathname
  const m = /^\/api\/plans\/([^/]+)$/.exec(path)
  if (!m || req.method !== 'GET') return false
  try {
    const body = JSON.stringify(hub.planRoutes(decodeURIComponent(m[1])))
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(body)
  } catch (error) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
  }
  return true
}

/** dist/ as built, with index.html for every route the app has */
function serveBuilt(dist: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname))
    let file = join(dist, path)
    if (!file.startsWith(dist + sep) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html')
    res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream')
    if (file.includes(`${sep}assets${sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    // Ranges, for the landing page's video to seek and loop
    const size = statSync(file).size
    res.setHeader('Accept-Ranges', 'bytes')
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` })
        res.end()
        return
      }
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
      createReadStream(file, { start, end }).pipe(res)
      return
    }
    res.setHeader('Content-Length', size)
    createReadStream(file).pipe(res)
  }
}

if (dev) {
  const { createServer: createVite } = await import('vite')
  const vite = await createVite({ root: frontendRoot, appType: 'spa', server: { middlewareMode: true, hmr: { server } } })
  server.on('request', (req, res) => {
    if (!servePlans(req, res)) vite.middlewares(req, res)
  })
} else {
  const dist = join(frontendRoot, 'dist')
  if (!existsSync(join(dist, 'index.html'))) {
    console.error('No dist/index.html: run `npm run build` first, or `npm run dev`')
    process.exit(1)
  }
  const built = serveBuilt(dist)
  server.on('request', (req, res) => {
    if (!servePlans(req, res)) built(req, res)
  })
}

hub.start()
server.listen(port, host, () => {
  const where = host === '0.0.0.0' ? `every interface, port ${port}` : `http://${host === '127.0.0.1' ? 'localhost' : host}:${port}`
  console.log(`Command Center${dev ? ' (dev)' : ''} on ${where}`)
  console.log(`  robots: ${storeFile} · plans: ${plansDir} · README commands run in ${packageRoot}`)
  if (process.env.MISSION_UNLOCKED === '1') console.log('  MISSION_UNLOCKED: the Command center opens without Setup and Routes confirmed')
  if (host !== '127.0.0.1' && host !== 'localhost') console.warn('  Open to the network: anyone who reaches this port gets shells on the robots')
})

let stopping = false
async function stop(signal: string) {
  if (stopping) return
  stopping = true
  console.log(`\n${signal}: stopping the relays this server started, then the terminals…`)
  await hub.shutdown()
  server.close()
  process.exit(0)
}
process.on('SIGINT', () => void stop('SIGINT'))
process.on('SIGTERM', () => void stop('SIGTERM'))
