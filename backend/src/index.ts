/**
 * HTTP entry point: Express app wiring, static file serving (uploads + built
 * frontend with SPA fallback) and the WebSocket server. Route handlers live
 * in ./routes, realtime logic in ./hub.
 */
import express from 'express'
import http from 'http'
import path from 'path'
import fs from 'fs'
import compression from 'compression'
import { WebSocketServer } from 'ws'
import { authRouter } from './routes/auth'
import { tablesRouter } from './routes/tables'
import { tokensRouter } from './routes/tokens'
import { settingsRouter } from './routes/settings'
import { portalsRouter } from './routes/portals'
import { assetsRouter } from './routes/assets'
import { setupWebSocket } from './hub'
import { apiLimiter } from './ratelimit'

// db is initialised on import (runs migrations)
import './db'

const app = express()
const server = http.createServer(app)

// Behind the Apache reverse proxy, client IPs arrive in X-Forwarded-For
// (one hop) — needed for meaningful rate-limit keys
app.set('trust proxy', 1)

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  if (req.method === 'OPTIONS') { res.sendStatus(204); return }
  next()
})

// HTTP compression (gzip/brotli via negotiate): the app JS is ~100 KB raw,
// ~27 KB compressed — a free win on every mobile page load
app.use(compression())

app.use(express.json({ limit: '10mb' }))

// Static: uploads. Files are content-unique (map_<floorId>.<ext>,
// asset_<id>.<ext>) and never rewritten in place, so browsers may cache
// them immutably — avoids re-downloading multi-MB map images on every visit.
const uploadsDir = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')
fs.mkdirSync(uploadsDir, { recursive: true })
app.use('/uploads', express.static(uploadsDir, {
  maxAge: '1y',
  immutable: true,
}))

// API routes (rate-limited; login applies its own stricter limiter)
app.use('/api', apiLimiter)
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

// Static: built frontend. Vite emits content-hashed asset filenames, so
// /assets/* may be cached forever; index.html must always be revalidated
// so clients pick up new builds.
const staticDir = process.env.STATIC_DIR || path.join(process.cwd(), 'public')
app.use(express.static(staticDir, {
  maxAge: '1y',
  immutable: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache')
    }
  },
}))

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
