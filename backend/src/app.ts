/**
 * Express app assembly: middleware, API routers, static file serving (uploads
 * + built frontend with SPA fallback). Route handlers live in ./routes,
 * realtime logic in ./hub, HTTP entry in ./index.
 */
import express from 'express'
import path from 'path'
import fs from 'fs'
import { authRouter } from './routes/auth'
import { tablesRouter } from './routes/tables'
import { tokensRouter } from './routes/tokens'
import { settingsRouter } from './routes/settings'
import { portalsRouter } from './routes/portals'
import { wallsRouter } from './routes/walls'
import { propsRouter } from './routes/props'
import { assetsRouter } from './routes/assets'
import { apiLimiter } from './ratelimit'

// db is initialised on import (runs migrations)
import './db'

const app = express()

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

app.use(express.json({ limit: '10mb' }))

// Static: uploads
const uploadsDir = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')
fs.mkdirSync(uploadsDir, { recursive: true })
app.use('/uploads', express.static(uploadsDir))

// API routes (rate-limited; login applies its own stricter limiter)
app.use('/api', apiLimiter)
app.use('/api', authRouter)
app.use('/api', tablesRouter)
app.use('/api', tokensRouter)
app.use('/api', settingsRouter)
app.use('/api', portalsRouter)
app.use('/api', wallsRouter)
app.use('/api', propsRouter)
app.use('/api', assetsRouter)

// Version information (backend package.json; the frontend ships its own)
const pkg = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { version?: string } }
  catch { return {} }
})()
app.get('/api/version', (_req, res) => {
  res.json({ version: pkg.version ?? '0.0.0', name: 'Simple VTT' })
})

// Unknown API paths must return JSON 404, not the SPA fallback below
app.use('/api', (_req, res) => { res.status(404).json({ error: 'not found' }) })

// Static: built frontend
const staticDir = process.env.STATIC_DIR || path.join(process.cwd(), 'public')
app.use(express.static(staticDir))

// SPA fallback (Express 5: bare '*' wildcards are gone — a terminal
// app.use handler catches every unmatched request instead)
app.use((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.status(404).send('not found'); return }
  const indexPath = path.join(staticDir, 'index.html')
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath)
  } else {
    res.status(404).send('Frontend not built. Run: cd frontend && npm run build')
  }
})

export default app
