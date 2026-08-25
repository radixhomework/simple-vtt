/**
 * Token CRUD + fog points. Hidden tokens are withheld from players at this
 * layer (list) and in the hub (live updates), so their position can never
 * reach a player's browser.
 */
import { Router } from 'express'
import { db } from '../db'
import { authMiddleware } from '../auth'
import { requireMapDM, isMapDM } from '../mapaccess'
import { pushTableStateToTable } from '../hub'

export const tokensRouter = Router()

function newId() { return crypto.randomUUID().replace(/-/g, '').slice(0, 16) }

const TOKEN_COLS = 'id, table_id, name, x, y, icon_path, has_vision, vision_radius, size, color, owner, hidden, floor_id'

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
  // Hidden tokens are invisible to map players — withhold them entirely
  const visible = isMapDM(res.locals.user, req.params.id, res.locals.role)
    ? rows
    : rows.filter(t => t.hidden !== 1)
  res.json(visible.map(normalizeToken))
})

tokensRouter.post('/tables/:id/tokens', authMiddleware, (req, res) => {
  if (!requireMapDM(req, res)) return
  const { name = '', x = 0, y = 0, icon_path = '', has_vision = false, vision_radius = 6, size = 0.75, color = '#4a90d9', owner = '', hidden = false } = req.body
  // Tokens live on a floor of the table (default: lowest level)
  const floor = (req.body.floor_id
    ? db.prepare('SELECT id FROM floors WHERE id=? AND table_id=?').get(req.body.floor_id, req.params.id)
    : db.prepare('SELECT id FROM floors WHERE table_id=? ORDER BY level, rowid LIMIT 1').get(req.params.id)
  ) as { id: string } | undefined
  if (!floor) { res.status(404).json({ error: 'floor not found' }); return }
  const id = newId()
  db.prepare('INSERT INTO tokens (id, table_id, name, x, y, icon_path, has_vision, vision_radius, size, color, owner, hidden, floor_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, req.params.id, name, x, y, icon_path, has_vision ? 1 : 0, vision_radius, size, color, owner, hidden ? 1 : 0, floor.id)
  const row = db.prepare(`SELECT ${TOKEN_COLS} FROM tokens WHERE id=?`).get(id) as Record<string, unknown>
  res.status(201).json(normalizeToken(row))
})

tokensRouter.put('/tables/:id/tokens/:tokenId', authMiddleware, (req, res) => {
  const existing = db.prepare(
    `SELECT ${TOKEN_COLS} FROM tokens WHERE id=? AND table_id=?`
  ).get(req.params.tokenId, req.params.id) as Record<string, unknown> | undefined

  if (!existing) { res.status(404).json({ error: 'not found' }); return }

  // Authorization: map dms may edit anything; players only their own tokens,
  // and cannot change owner/hidden (dm-only controls).
  const isAdmin = isMapDM(res.locals.user, req.params.id, res.locals.role)
  if (!isAdmin && existing.owner !== res.locals.user) {
    res.status(403).json({ error: 'forbidden' }); return
  }

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
    owner:         isAdmin && b.owner !== undefined ? b.owner : existing.owner,
    hidden:        isAdmin && b.hidden !== undefined ? b.hidden : existing.hidden,
    floor_id:      existing.floor_id,
  }

  // Floor change: target floor must belong to the same table
  if (b.floor_id !== undefined && b.floor_id !== existing.floor_id) {
    const floor = db.prepare('SELECT id FROM floors WHERE id=? AND table_id=?').get(b.floor_id, req.params.id)
    if (!floor) { res.status(404).json({ error: 'floor not found' }); return }
    merged.floor_id = b.floor_id
  }

  db.prepare(
    'UPDATE tokens SET name=?, x=?, y=?, icon_path=?, has_vision=?, vision_radius=?, size=?, color=?, owner=?, hidden=?, floor_id=? WHERE id=? AND table_id=?'
  ).run(merged.name, merged.x, merged.y, merged.icon_path, merged.has_vision ? 1 : 0, merged.vision_radius, merged.size, merged.color, merged.owner, merged.hidden ? 1 : 0, merged.floor_id, req.params.tokenId, req.params.id)

  // Visibility changes must reach players even though the client follows up
  // with a WS token_update (by then the DB is already updated, so the hub's
  // own change detection would see no difference).
  const hiddenBool = (v: unknown) => v === 1 || v === true
  const hiddenChanged = hiddenBool(existing.hidden) !== hiddenBool(merged.hidden)
  const floorChanged = merged.floor_id !== existing.floor_id
  if (hiddenChanged || floorChanged) {
    pushTableStateToTable(req.params.id)
  }

  const row = db.prepare(
    `SELECT ${TOKEN_COLS} FROM tokens WHERE id=?`
  ).get(req.params.tokenId) as Record<string, unknown>
  res.json(normalizeToken(row))
})

tokensRouter.delete('/tables/:id/tokens/:tokenId', authMiddleware, (req, res) => {
  if (!requireMapDM(req, res)) return
  db.prepare('DELETE FROM tokens WHERE id=? AND table_id=?').run(req.params.tokenId, req.params.id)
  res.sendStatus(204)
})

// ── Fog points ────────────────────────────────────────────────────────────────
tokensRouter.get('/tables/:id/fog', authMiddleware, (req, res) => {
  const floor = typeof req.query.floor_id === 'string' ? req.query.floor_id : null
  res.json(floor
    ? db.prepare('SELECT id, table_id, x, y, radius, floor_id FROM fog_points WHERE table_id=? AND floor_id=?').all(req.params.id, floor)
    : db.prepare('SELECT id, table_id, x, y, radius, floor_id FROM fog_points WHERE table_id=?').all(req.params.id))
})

tokensRouter.post('/tables/:id/fog', authMiddleware, (req, res) => {
  if (!requireMapDM(req, res)) return
  const { x, y, radius = 3, floor_id } = req.body
  const id = newId()
  db.prepare('INSERT INTO fog_points (id, table_id, x, y, radius, floor_id) VALUES (?,?,?,?,?,?)')
    .run(id, req.params.id, x, y, radius, floor_id ?? '')
  res.status(201).json({ id, table_id: req.params.id, x, y, radius, floor_id: floor_id ?? '' })
})

tokensRouter.delete('/tables/:id/fog', authMiddleware, (req, res) => {
  if (!requireMapDM(req, res)) return
  // ?floor_id= scopes the clear to one level; without it, all floors
  const floor = typeof req.query.floor_id === 'string' ? req.query.floor_id : null
  if (floor) db.prepare('DELETE FROM fog_points WHERE table_id=? AND floor_id=?').run(req.params.id, floor)
  else db.prepare('DELETE FROM fog_points WHERE table_id=?').run(req.params.id)
  res.sendStatus(204)
})
