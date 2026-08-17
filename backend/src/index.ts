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
import { musicRouter } from './routes/music'
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
app.use('/api', musicRouter)

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
