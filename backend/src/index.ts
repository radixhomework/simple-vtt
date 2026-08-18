/**
 * HTTP entry point: Express app wiring, static file serving (uploads + built
 * frontend with SPA fallback) and the WebSocket server. Route handlers live
 * in ./routes, realtime logic in ./hub.
 */
import express from 'express'
import http from 'http'
import path from 'path'
import fs from 'fs'
import { WebSocketServer } from 'ws'
import { authRouter } from './routes/auth'
import { tablesRouter } from './routes/tables'
import { tokensRouter } from './routes/tokens'
import { settingsRouter } from './routes/settings'
import { portalsRouter } from './routes/portals'
import { assetsRouter } from './routes/assets'
import { setupWebSocket } from './hub'

// db is initialised on import (runs migrations)
import './db'

const app = express()
const server = http.createServer(app)

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  if (req.method === 'OPTIONS') { res.sendStatus(204); return }
  next()
})

app.use(express.json({ limit: '10mb' }))

// Static: uploads
const uploadsDir = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')
fs.mkdirSync(uploadsDir, { recursive: true })
app.use('/uploads', express.static(uploadsDir))

// API routes
app.use('/api', authRouter)
app.use('/api', tablesRouter)
app.use('/api', tokensRouter)
app.use('/api', settingsRouter)
app.use('/api', portalsRouter)
app.use('/api', assetsRouter)

// Version information (backend package.json; the frontend ships its own)
const pkg = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { version?: string } }
  catch { return {} }
})()
app.get('/api/version', (_req, res) => {
  res.json({ version: pkg.version ?? '0.0.0', name: 'RHW Simple VTT' })
})

// Unknown API paths must return JSON 404, not the SPA fallback below
app.use('/api', (_req, res) => { res.status(404).json({ error: 'not found' }) })

// Static: built frontend
const staticDir = process.env.STATIC_DIR || path.join(process.cwd(), 'public')
app.use(express.static(staticDir))

// SPA fallback
app.get('*', (_req, res) => {
  const indexPath = path.join(staticDir, 'index.html')
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath)
  } else {
    res.status(404).send('Frontend not built. Run: cd frontend && npm run build')
  }
})

// WebSocket
const wss = new WebSocketServer({ server, path: '/ws' })
setupWebSocket(wss)

const port = parseInt(process.env.PORT || '8080', 10)
server.listen(port, () => {
  console.log(`RHW Simple VTT listening on :${port}`)
})
