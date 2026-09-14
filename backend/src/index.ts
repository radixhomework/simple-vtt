/**
 * HTTP entry point: boots the assembled Express app and attaches the
 * WebSocket server. App wiring lives in ./app, routes in ./routes,
 * realtime logic in ./hub.
 */
import http from 'http'
import { WebSocketServer } from 'ws'
import { setupWebSocket } from './hub'
import app from './app'

const port = parseInt(process.env.PORT || '8080', 10)
const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })
setupWebSocket(wss)

server.listen(port, () => {
  console.log(`Simple VTT listening on :${port}`)
})
