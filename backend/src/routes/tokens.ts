import { Router } from 'express'
import { db } from '../db'
import { authMiddleware, adminOnly } from '../auth'
import { pushTableStateToTable } from '../hub'

export const tokensRouter = Router()

function newId() { return crypto.randomUUID().replace(/-/g, '').slice(0, 16) }

const TOKEN_COLS = 'id, table_id, name, x, y, icon_path, has_vision, vision_radius, size, color, owner, hidden'

function normalizeToken(row: Record<string, unknown>) {
  return {
    ...row,
    has_vision: row.has_vision === 1 || row.has_vision === true,
    hidden: row.hidden === 1 || row.hidden === true,
  }
}

// ── Tokens ────────────────────────────────────────────────────────────────────
tokensRouter.get('/tables/:id/tokens', authMiddleware, (req, res) => {
  const rows = db.prepare(`SELECT ${TOKEN_COLS} FROM tokens WHERE table_id=?`).all(req.params.id) as Array<Record<string, unknown>>
  // Hidden tokens are invisible to players — withhold them entirely
  const visible = res.locals.role === 'admin'
    ? rows
    : rows.filter(t => t.hidden !== 1)
  res.json(visible.map(normalizeToken))
})

tokensRouter.post('/tables/:id/tokens', authMiddleware, adminOnly, (req, res) => {
  const { name = '', x = 0, y = 0, icon_path = '', has_vision = false, vision_radius = 6, size = 1, color = '#4a90d9', owner = '', hidden = false } = req.body
  const id = newId()
  db.prepare('INSERT INTO tokens (id, table_id, name, x, y, icon_path, has_vision, vision_radius, size, color, owner, hidden) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, req.params.id, name, x, y, icon_path, has_vision ? 1 : 0, vision_radius, size, color, owner, hidden ? 1 : 0)
  const row = db.prepare(`SELECT ${TOKEN_COLS} FROM tokens WHERE id=?`).get(id) as Record<string, unknown>
  res.status(201).json(normalizeToken(row))
})

tokensRouter.put('/tables/:id/tokens/:tokenId', authMiddleware, (req, res) => {
  const existing = db.prepare(
    `SELECT ${TOKEN_COLS} FROM tokens WHERE id=? AND table_id=?`
  ).get(req.params.tokenId, req.params.id) as Record<string, unknown> | undefined

  if (!existing) { res.status(404).json({ error: 'not found' }); return }

  // Merge: only override fields that are explicitly present in the request body
  const b = req.body
  const merged = {
    name:          b.name          !== undefined ? b.name          : existing.name,
    x:             b.x             !== undefined ? b.x             : existing.x,
    y:             b.y             !== undefined ? b.y             : existing.y,
    icon_path:     b.icon_path     !== undefined ? b.icon_path     : existing.icon_path,
    has_vision:    b.has_vision    !== undefined ? b.has_vision    : existing.has_vision,
    vision_radius: b.vision_radius !== undefined ? b.vision_radius : existing.vision_radius,
    size:          b.size          !== undefined ? b.size          : existing.size,
    color:         b.color         !== undefined ? b.color         : existing.color,
    owner:         b.owner         !== undefined ? b.owner         : existing.owner,
    hidden:        b.hidden        !== undefined ? b.hidden        : existing.hidden,
  }

  db.prepare(
    'UPDATE tokens SET name=?, x=?, y=?, icon_path=?, has_vision=?, vision_radius=?, size=?, color=?, owner=?, hidden=? WHERE id=? AND table_id=?'
  ).run(merged.name, merged.x, merged.y, merged.icon_path, merged.has_vision ? 1 : 0, merged.vision_radius, merged.size, merged.color, merged.owner, merged.hidden ? 1 : 0, req.params.tokenId, req.params.id)

  // Visibility changes must reach players even though the client follows up
  // with a WS token_update (by then the DB is already updated, so the hub's
  // own change detection would see no difference).
  const hiddenBool = (v: unknown) => v === 1 || v === true
  const hiddenChanged = hiddenBool(existing.hidden) !== hiddenBool(merged.hidden)
  if (hiddenChanged) {
    pushTableStateToTable(req.params.id)
  }

  const row = db.prepare(
    `SELECT ${TOKEN_COLS} FROM tokens WHERE id=?`
  ).get(req.params.tokenId) as Record<string, unknown>
  res.json(normalizeToken(row))
})

tokensRouter.delete('/tables/:id/tokens/:tokenId', authMiddleware, adminOnly, (req, res) => {
  db.prepare('DELETE FROM tokens WHERE id=? AND table_id=?').run(req.params.tokenId, req.params.id)
  res.sendStatus(204)
})

// ── Fog points ────────────────────────────────────────────────────────────────
tokensRouter.get('/tables/:id/fog', authMiddleware, (req, res) => {
  res.json(db.prepare('SELECT id, table_id, x, y, radius FROM fog_points WHERE table_id=?').all(req.params.id))
})

tokensRouter.post('/tables/:id/fog', authMiddleware, adminOnly, (req, res) => {
  const { x, y, radius = 3 } = req.body
  const id = newId()
  db.prepare('INSERT INTO fog_points (id, table_id, x, y, radius) VALUES (?,?,?,?,?)').run(id, req.params.id, x, y, radius)
  res.status(201).json({ id, table_id: req.params.id, x, y, radius })
})

tokensRouter.delete('/tables/:id/fog', authMiddleware, adminOnly, (req, res) => {
  db.prepare('DELETE FROM fog_points WHERE table_id=?').run(req.params.id)
  res.sendStatus(204)
})
