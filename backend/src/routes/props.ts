/**
 * Map props — independent decorative assets (trees, furniture) placed on a
 * floor. DM-editable at all times (play AND build mode); purely visual:
 * props never block sight or movement.
 *
 * Every mutation broadcasts `props_update` so every client refetches the
 * floor's props (same pattern as walls_update).
 */
import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { db } from '../db'
import { authMiddleware } from '../auth'
import { requireMapDM } from '../mapaccess'
import { broadcastToTable } from '../hub'

export const propsRouter = Router()

function newId(): string { return randomUUID().replace(/-/g, '').slice(0, 16) }

const PROP_COLS = 'id, table_id, floor_id, asset_path, name, x, y, size, rotation, z, opacity, group_id'

function pushProps(tableId: string) {
  broadcastToTable(tableId, { type: 'props_update', payload: {} })
}

/** Validate + clamp a numeric prop field; returns [ok, value]. */
function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** Create a prop (DM). asset_path must exist in the shared library. */
propsRouter.post('/tables/:id/props', authMiddleware, (req, res) => {
  if (!requireMapDM(req, res, req.params.id)) return
  const b = req.body as Record<string, unknown>
  const floorId = typeof b.floor_id === 'string' ? b.floor_id : ''
  const floor = db.prepare('SELECT id FROM floors WHERE id=? AND table_id=?').get(floorId, req.params.id)
  if (!floor) { res.status(404).json({ error: 'floor not found' }); return }
  const assetPath = typeof b.asset_path === 'string' ? b.asset_path : ''
  if (!assetPath.startsWith('/uploads/')) { res.status(400).json({ error: 'asset_path must be an uploads path' }); return }
  const x = Number(b.x), y = Number(b.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) { res.status(400).json({ error: 'finite x/y required' }); return }

  const id = newId()
  db.prepare(`INSERT INTO props (id, table_id, floor_id, asset_path, name, x, y, size, rotation, z, opacity)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      id, req.params.id, floorId, assetPath,
      typeof b.name === 'string' ? b.name.slice(0, 60) : '',
      x, y,
      num(b.size, 70, 4, 10000),
      num(b.rotation, 0, -360, 360),
      Math.trunc(num(b.z, 0, -1000, 1000)),
      num(b.opacity, 1, 0.05, 1),
    )
  const row = db.prepare(`SELECT ${PROP_COLS} FROM props WHERE id=?`).get(id)
  pushProps(req.params.id)
  res.status(201).json(row)
})

/** List the props of one floor (all roles — players see the scenery). */
propsRouter.get('/tables/:id/props', authMiddleware, (req, res) => {
  const floorId = typeof req.query.floor_id === 'string' ? req.query.floor_id : ''
  const rows = floorId
    ? db.prepare(`SELECT ${PROP_COLS} FROM props WHERE table_id=? AND floor_id=? ORDER BY z, rowid`).all(req.params.id, floorId)
    : db.prepare(`SELECT ${PROP_COLS} FROM props WHERE table_id=? ORDER BY floor_id, z, rowid`).all(req.params.id)
  res.json(rows)
})

/** Patch a prop (DM): any of geometry/name/opacity. */
propsRouter.patch('/tables/:id/props/:propId', authMiddleware, (req, res) => {
  if (!requireMapDM(req, res, req.params.id)) return
  const existing = db.prepare(`SELECT ${PROP_COLS} FROM props WHERE id=? AND table_id=?`)
    .get(req.params.propId, req.params.id) as Record<string, unknown> | undefined
  if (!existing) { res.status(404).json({ error: 'not found' }); return }
  const b = req.body as Record<string, unknown>
  const merged = {
    asset_path: typeof b.asset_path === 'string' && b.asset_path.startsWith('/uploads/') ? b.asset_path : existing.asset_path,
    name: typeof b.name === 'string' ? b.name.slice(0, 60) : existing.name,
    x: b.x !== undefined ? num(b.x, existing.x as number, -1e7, 1e7) : existing.x,
    y: b.y !== undefined ? num(b.y, existing.y as number, -1e7, 1e7) : existing.y,
    size: b.size !== undefined ? num(b.size, existing.size as number, 4, 10000) : existing.size,
    rotation: b.rotation !== undefined ? num(b.rotation, existing.rotation as number, -360, 360) : existing.rotation,
    z: b.z !== undefined ? Math.trunc(num(b.z, existing.z as number, -1000, 1000)) : existing.z,
    opacity: b.opacity !== undefined ? num(b.opacity, existing.opacity as number, 0.05, 1) : existing.opacity,
  }
  db.prepare('UPDATE props SET asset_path=?, name=?, x=?, y=?, size=?, rotation=?, z=?, opacity=? WHERE id=?')
    .run(merged.asset_path, merged.name, merged.x, merged.y, merged.size, merged.rotation, merged.z, merged.opacity, req.params.propId)
  const row = db.prepare(`SELECT ${PROP_COLS} FROM props WHERE id=?`).get(req.params.propId)
  pushProps(req.params.id)
  res.json(row)
})

propsRouter.delete('/tables/:id/props/:propId', authMiddleware, (req, res) => {
  if (!requireMapDM(req, res, req.params.id)) return
  const existing = db.prepare('SELECT id FROM props WHERE id=? AND table_id=?').get(req.params.propId, req.params.id)
  if (!existing) { res.sendStatus(204); return }
  db.prepare('DELETE FROM props WHERE id=?').run(req.params.propId)
  pushProps(req.params.id)
  res.sendStatus(204)
})
