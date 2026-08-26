/**
 * Build-mode walls — sight/movement blockers in world px, per floor.
 * Admin (map DM) only: players never edit walls.
 *
 * Every mutation broadcasts `walls_update` so every client rebuilds its
 * LOS inputs immediately (wallVersion bump client-side).
 */
import { Router } from 'express'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { authMiddleware } from '../auth'
import { requireMapDM } from '../mapaccess'
import { broadcastToTable } from '../hub'

export const wallsRouter = Router()

function newId(): string { return randomUUID().replace(/-/g, '').slice(0, 16) }

const WALL_COLS = 'id, table_id, floor_id, ax, ay, bx, by'

interface WallBody { ax: number; ay: number; bx: number; by: number }

function coerceWallBody(b: Record<string, unknown>): WallBody | null {
  const ax = Number(b.ax), ay = Number(b.ay), bx = Number(b.bx), by = Number(b.by)
  if (![ax, ay, bx, by].every(Number.isFinite)) return null
  return { ax, ay, bx, by }
}

function pushWalls(tableId: string) {
  broadcastToTable(tableId, { type: 'walls_update', payload: {} })
}

wallsRouter.post('/tables/:id/walls', authMiddleware, (req, res) => {
  if (!requireMapDM(req, res, req.params.id)) return
  const floorId = String(req.body.floor_id ?? '')
  const floor = db.prepare('SELECT id FROM floors WHERE id=? AND table_id=?').get(floorId, req.params.id)
  if (!floor) { res.status(404).json({ error: 'floor not found' }); return }

  const single = coerceWallBody(req.body)
  const items: WallBody[] = single
    ? [single]
    : Array.isArray(req.body.walls) ? req.body.walls.map(coerceWallBody).filter(Boolean) as WallBody[] : []
  if (items.length === 0) { res.status(400).json({ error: 'no valid walls' }); return }

  const insert = db.prepare('INSERT INTO walls (id, table_id, floor_id, ax, ay, bx, by) VALUES (?,?,?,?,?,?,?)')
  const createdIds: string[] = []
  db.transaction(() => {
    for (const w of items) {
      const id = newId()
      insert.run(id, req.params.id, floorId, w.ax, w.ay, w.bx, w.by)
      createdIds.push(id)
    }
  })()
  const rows = createdIds.length === 1
    ? [db.prepare(`SELECT ${WALL_COLS} FROM walls WHERE id=?`).get(createdIds[0])]
    : db.prepare(`SELECT ${WALL_COLS} FROM walls WHERE table_id=? AND floor_id=?`).all(req.params.id, floorId)
  pushWalls(req.params.id)
  res.status(201).json(rows)
})

wallsRouter.put('/walls/:id', authMiddleware, (req, res) => {
  const existing = db.prepare(`SELECT ${WALL_COLS} FROM walls WHERE id=?`).get(req.params.id) as Record<string, unknown> | undefined
  if (!existing) { res.status(404).json({ error: 'not found' }); return }
  if (!requireMapDM(req, res, String(existing.table_id))) return
  const w = coerceWallBody(req.body)
  if (!w) { res.status(400).json({ error: 'ax/ay/bx/by required' }); return }
  db.prepare('UPDATE walls SET ax=?, ay=?, bx=?, by=? WHERE id=?').run(w.ax, w.ay, w.bx, w.by, req.params.id)
  pushWalls(String(existing.table_id))
  res.json({ ...existing, ...w })
})

/** Batch move: translate a set of walls by (dx, dy) world px — the group
 *  drag from build mode. Atomic; one broadcast at the end. */
wallsRouter.patch('/tables/:id/walls/move', authMiddleware, (req, res) => {
  if (!requireMapDM(req, res, req.params.id)) return
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(String) : []
  const dx = Number(req.body.dx), dy = Number(req.body.dy)
  if (ids.length === 0 || !Number.isFinite(dx) || !Number.isFinite(dy)) {
    res.status(400).json({ error: 'ids and finite dx/dy required' }); return
  }
  const update = db.prepare('UPDATE walls SET ax=ax+?, ay=ay+?, bx=bx+?, by=by+? WHERE id=? AND table_id=?')
  db.transaction(() => {
    for (const id of ids) update.run(dx, dy, dx, dy, id, req.params.id)
  })()
  pushWalls(req.params.id)
  res.json({ moved: ids.length })
})

wallsRouter.delete('/walls/:id', authMiddleware, (req, res) => {
  const existing = db.prepare(`SELECT ${WALL_COLS} FROM walls WHERE id=?`).get(req.params.id) as Record<string, unknown> | undefined
  if (!existing) { res.status(404).json({ error: 'not found' }); return }
  if (!requireMapDM(req, res, String(existing.table_id))) return
  db.prepare('DELETE FROM walls WHERE id=?').run(req.params.id)
  pushWalls(String(existing.table_id))
  res.sendStatus(204)
})

wallsRouter.get('/tables/:id/walls', authMiddleware, (req, res) => {
  const rows = db.prepare(`SELECT ${WALL_COLS} FROM walls WHERE table_id=?`).all(req.params.id)
  res.json(rows)
})
