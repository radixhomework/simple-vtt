/**
 * Portals — doors and windows, per floor. Admins toggle open/closed and can
 * reclassify a portal (door ↔ window). Players may toggle them too when the
 * matching global setting allows it.
 *
 * Semantics: a closed door blocks movement AND sight; a closed window blocks
 * movement but stays transparent. Open portals block neither.
 */
import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { db } from '../db'
import { authMiddleware } from '../auth'
import { isMapDM, requireMapDM, param } from '../mapaccess'
import { broadcastToTable, pushTableStateToTable } from '../hub'
import { loadTableSettings } from '../settings'

export const portalsRouter = Router()

const PORTAL_COLS = 'id, table_id, x1, y1, x2, y2, closed, floor_id, kind, locked'

function normalize(row: Record<string, unknown>) {
  return {
    ...row,
    closed: row.closed === 1 || row.closed === true,
    locked: row.locked === 1 || row.locked === true,
  }
}

/** Players may toggle a portal when the map's settings allow it for its
 *  kind AND this particular portal is not individually locked. */
function playerMayOpen(role: string, tableId: string, kind: string, locked: boolean): boolean {
  if (role === 'admin') return true
  if (locked) return false
  const settings = loadTableSettings(tableId)
  return kind === 'window' ? settings.players_open_windows : settings.players_open_doors
}

portalsRouter.get('/tables/:id/portals', authMiddleware, (req, res) => {
  const rows = db.prepare(`SELECT ${PORTAL_COLS} FROM portals WHERE table_id=?`)
    .all(param(req, 'id')) as Record<string, unknown>[]
  res.json(rows.map(normalize))
})

/** Build mode: place a door or window (admin only). */
portalsRouter.post('/tables/:id/portals', authMiddleware, (req, res) => {
  if (!requireMapDM(req, res, param(req, 'id'))) return
  const b = req.body as { x1: number; y1: number; x2: number; y2: number; kind?: string; floor_id?: string; closed?: boolean }
  const nums = [b.x1, b.y1, b.x2, b.y2].map(Number)
  if (nums.some(n => !Number.isFinite(n))) { res.status(400).json({ error: 'x1/y1/x2/y2 required' }); return }
  const kind = b.kind === 'window' ? 'window' : 'door'
  const floor = db.prepare('SELECT id FROM floors WHERE id=? AND table_id=?').get(String(b.floor_id ?? ''), param(req, 'id'))
  if (!floor) { res.status(404).json({ error: 'floor not found' }); return }
  const id = randomUUID().replace(/-/g, '').slice(0, 16)
  db.prepare('INSERT INTO portals (id, table_id, x1, y1, x2, y2, closed, floor_id, kind, locked) VALUES (?,?,?,?,?,?,?,?,?,0)')
    .run(id, param(req, 'id'), b.x1, b.y1, b.x2, b.y2, b.closed === false ? 0 : 1, String(b.floor_id), kind)
  const row = db.prepare(`SELECT ${PORTAL_COLS} FROM portals WHERE id=?`).get(id) as Record<string, unknown>
  pushTableStateToTable(param(req, 'id'))
  res.status(201).json(normalize(row))
})

/** Build mode: delete a portal (admin only). */
portalsRouter.delete('/tables/:id/portals/:portalId', authMiddleware, (req, res) => {
  if (!requireMapDM(req, res, param(req, 'id'))) return
  const existing = db.prepare(`SELECT ${PORTAL_COLS} FROM portals WHERE id=? AND table_id=?`)
    .get(param(req, 'portalId'), param(req, 'id')) as Record<string, unknown> | undefined
  if (!existing) { res.status(404).json({ error: 'not found' }); return }
  db.prepare('DELETE FROM portals WHERE id=?').run(param(req, 'portalId'))
  pushTableStateToTable(param(req, 'id'))
  res.sendStatus(204)
})

portalsRouter.patch('/tables/:id/portals/:portalId', authMiddleware, (req, res) => {
  const id = param(req, 'id')
  const portalId = param(req, 'portalId')
  const existing = db.prepare(`SELECT ${PORTAL_COLS} FROM portals WHERE id=? AND table_id=?`)
    .get(portalId, id) as Record<string, unknown> | undefined
  if (!existing) { res.status(404).json({ error: 'not found' }); return }

  const isAdmin = isMapDM(res.locals.user, param(req, 'id'), res.locals.role)
  const kind = String(existing.kind) || 'door'

  const locked = existing.locked === 1 || existing.locked === true

  // Reclassification (door ↔ window) and per-portal locks are admin-only
  const newKind = req.body.kind
  if (newKind !== undefined) {
    if (!isAdmin) { res.status(403).json({ error: 'forbidden' }); return }
    if (newKind !== 'door' && newKind !== 'window') { res.status(400).json({ error: 'kind must be door or window' }); return }
    db.prepare('UPDATE portals SET kind=? WHERE id=?').run(newKind, portalId)
  }
  if (req.body.locked !== undefined) {
    if (!isAdmin) { res.status(403).json({ error: 'forbidden' }); return }
    db.prepare('UPDATE portals SET locked=? WHERE id=?').run(req.body.locked ? 1 : 0, portalId)
  }

  // Open/close: admins always; players when allowed for the kind and not locked
  if (req.body.closed !== undefined) {
    if (!playerMayOpen(res.locals.role, id, kind, locked)) { res.status(403).json({ error: 'forbidden' }); return }
    db.prepare('UPDATE portals SET closed=? WHERE id=?').run(req.body.closed ? 1 : 0, portalId)
  }

  // Geometry edit (build mode): move/resize the door/window. Admin-only.
  if (req.body.x1 !== undefined || req.body.y1 !== undefined || req.body.x2 !== undefined || req.body.y2 !== undefined) {
    if (!isAdmin) { res.status(403).json({ error: 'forbidden' }); return }
    const x1 = Number(req.body.x1 ?? existing.x1), y1 = Number(req.body.y1 ?? existing.y1)
    const x2 = Number(req.body.x2 ?? existing.x2), y2 = Number(req.body.y2 ?? existing.y2)
    if (![x1, y1, x2, y2].every(Number.isFinite)) { res.status(400).json({ error: 'finite x1/y1/x2/y2 required' }); return }
    db.prepare('UPDATE portals SET x1=?, y1=?, x2=?, y2=? WHERE id=?').run(x1, y1, x2, y2, param(req, 'portalId'))
    // Geometry feeds LOS/movement walls on every client — full resync.
    pushTableStateToTable(param(req, 'id'))
  }

  const row = db.prepare(`SELECT ${PORTAL_COLS} FROM portals WHERE id=?`)
    .get(portalId) as Record<string, unknown>
  const portal = normalize(row)
  broadcastToTable(param(req, 'id'), { type: 'portal_toggle', payload: { portal } })
  res.json(portal)
})
