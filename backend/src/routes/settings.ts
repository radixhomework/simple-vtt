import { Router } from 'express'
import { db } from '../db'
import { authMiddleware, adminOnly } from '../auth'
import { broadcastToAll } from '../hub'
import { loadSettings, sanitizeSettingsPatch } from '../settings'

export const settingsRouter = Router()

settingsRouter.get('/settings', authMiddleware, (_req, res) => {
  res.json(loadSettings())
})

settingsRouter.patch('/settings', authMiddleware, adminOnly, (req, res) => {
  const patches = sanitizeSettingsPatch(req.body as Record<string, unknown>)
  if (Object.keys(patches).length > 0) {
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    const tx = db.transaction(() => {
      for (const [key, value] of Object.entries(patches)) {
        upsert.run(key, value)
      }
    })
    tx()
  }

  const settings = loadSettings()
  // Push to every connected WebSocket client so the UI updates live
  broadcastToAll({ type: 'settings_update', payload: { settings } })
  res.json(settings)
})
