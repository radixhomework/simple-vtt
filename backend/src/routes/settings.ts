import { Router } from 'express'
import { db } from '../db'
import { authMiddleware, adminOnly } from '../auth'
import { broadcastToAll } from '../hub'

export const settingsRouter = Router()

function loadSettings(): Record<string, boolean> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  return Object.fromEntries(rows.map(r => [r.key, r.value === 'true']))
}

settingsRouter.get('/settings', authMiddleware, (_req, res) => {
  res.json(loadSettings())
})

settingsRouter.patch('/settings', authMiddleware, adminOnly, (req, res) => {
  const updates = req.body as Record<string, boolean>
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(updates)) {
      upsert.run(key, String(value))
    }
  })
  tx()

  const settings = loadSettings()
  // Push to every connected WebSocket client so the UI updates live
  broadcastToAll({ type: 'settings_update', payload: { settings } })
  res.json(settings)
})
