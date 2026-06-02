import { CompilerModule } from '@root/main/modules/compiler'
import { HardwareModule } from '@root/main/modules/hardware'
import ApiBridge from '@root/main/modules/ipc/main'
import { PouService, ProjectService, UserService } from '@root/main/services'
import { type BridgeEventPayload, serverEventBus } from '@root/server/event-bus'
import express from 'express'
import { createServer } from 'http'
import { enableMapSet } from 'immer'
import { join } from 'path'
import { type RawData, WebSocketServer } from 'ws'

enableMapSet()

const API_PORT = Number(process.env.API_PORT || 3001)

function decodeRawMessage(raw: RawData): string {
  if (typeof raw === 'string') return raw
  if (Buffer.isBuffer(raw)) return raw.toString('utf8')
  if (Array.isArray(raw)) {
    let offset = 0
    const buffers = raw.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as ArrayBuffer)))
    const merged = Buffer.alloc(buffers.reduce((sum, buf) => sum + buf.length, 0))
    for (const buf of buffers) {
      merged.set(buf, offset)
      offset += buf.length
    }
    return merged.toString('utf8')
  }
  return Buffer.from(raw as unknown as ArrayBuffer).toString('utf8')
}

function bootstrap(): void {
  new UserService()

  const app = express()
  app.use(express.json({ limit: '50mb' }))

  const projectService = new ProjectService()
  const pouService = new PouService()
  const compilerModule = new CompilerModule()
  const hardwareModule = new HardwareModule()

  const apiBridge = new ApiBridge({
    projectService,
    pouService,
    compilerModule,
    hardwareModule,
  })

  apiBridge.registerHttpRoutes(app)

  if (process.env.NODE_ENV === 'production') {
    const staticPath = join(process.cwd(), 'release', 'app', 'dist', 'renderer')
    app.use(express.static(staticPath))
    app.get('*', (_req, res) => {
      res.sendFile(join(staticPath, 'index.html'))
    })
  }

  const server = createServer(app)
  const wss = new WebSocketServer({ server, path: '/api/ws' })

  wss.on('connection', (socket) => {
    const forwardEvent = ({ channel, args }: BridgeEventPayload) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'event', channel, args }))
      }
    }

    serverEventBus.on('bridge-event', forwardEvent)

    socket.on('message', (raw) => {
      try {
        const payload = JSON.parse(decodeRawMessage(raw)) as { type: string; args?: unknown[] }
        apiBridge.handleWebSocketMessage(socket, payload)
      } catch (error) {
        console.error('Invalid websocket message:', error)
      }
    })

    socket.on('close', () => {
      serverEventBus.off('bridge-event', forwardEvent)
    })
  })

  server.listen(API_PORT, () => {
    console.log(`OpenPLC web API listening on http://localhost:${API_PORT}`)
  })
}

void bootstrap()
