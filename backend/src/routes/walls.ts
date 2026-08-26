/**
 * Build-mode walls — sight/movement blockers in world px, per floor.
 * Admin (map DM) only: players never edit walls.
 *
 * Every mutation broadcasts `walls_update` so every client rebuilds its
 * LOS inputs immediately (wallVersion bump client-side).
 */
import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { db } from '../db'
import { authMiddleware } from '../auth'
import { requireMapDM } from '../mapaccess'
import { broadcastToTable, pushTableStateToTable } from '../hub'

export const wallsRouter = Router()

function newId(): string { return randomUUID().replace(/-/g, '').slice(0, 16) }

const WALL_COLS = 'id, table_id, floor_id, ax, ay, bx, by, group_id'

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
  let items: WallBody[]
  if (single) {
    items = [single]
  } else if (Array.isArray(req.body.walls)) {
    items = req.body.walls.map(coerceWallBody).filter(Boolean) as WallBody[]
  } else {
    items = []
  }
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


/** Explicit grouping: assign or clear a shared group_id on walls+props.
 *  Link: every listed id gets the same fresh group id (members of other
 *  groups keep theirs; an id listed in two groups belongs to the last one).
 *  Unlink: clears group membership for the listed ids. One transaction,
 *  then walls_update + props_update + table_state push. */
wallsRouter.put('/tables/:id/floors/:floorId/link', authMiddleware, (req, res) => {
  if (!requireMapDM(req, res, req.params.id)) return
  const floor = db.prepare('SELECT id FROM floors WHERE id=? AND table_id=?').get(req.params.floorId, req.params.id)
  if (!floor) { res.status(404).json({ error: 'floor not found' }); return }

  const wallIds = (Array.isArray(req.body.wallIds) ? req.body.wallIds : []) as unknown[]
  const propIds = (Array.isArray(req.body.propIds) ? req.body.propIds : []) as unknown[]
  const clean = (v: unknown) => (typeof v === 'string' && /^[a-f0-9]{8,32}$/.test(v) ? v : null)
  const wids = wallIds.map(clean).filter((v): v is string => v !== null)
  const pids = propIds.map(clean).filter((v): v is string => v !== null)
  if (wids.length + pids.length === 0) { res.status(400).json({ error: 'no members' }); return }

  const groupId = req.body.action === 'unlink' ? '' : newId()
  const upWall = db.prepare('UPDATE walls SET group_id=? WHERE id=? AND table_id=? AND floor_id=?')
  const upProp = db.prepare('UPDATE props SET group_id=? WHERE id=? AND table_id=? AND floor_id=?')
  db.transaction(() => {
    for (const id of wids) upWall.run(groupId, id, req.params.id, req.params.floorId)
    for (const id of pids) upProp.run(groupId, id, req.params.id, req.params.floorId)
  })()
  broadcastToTable(req.params.id, { type: 'walls_update', payload: {} })
  broadcastToTable(req.params.id, { type: 'props_update', payload: {} })
  pushTableStateToTable(req.params.id)
  res.json({ group_id: groupId, walls: wids.length, props: pids.length })
})

/** Build snapshot restore (undo/redo): atomically replace ALL walls,
 *  portals and stairs of one floor with the given rows, KEEPING their ids.
 *
 *  One transaction, then one walls_update + one table_state push. Because
 *  the wipe is server-side and the insert preserves snapshot ids, the floor
 *  ends with EXACTLY the snapshot's rows — no stale-id deletes, no races
 *  with in-flight per-row requests, no duplication. */
wallsRouter.put('/tables/:id/floors/:floorId/build-state', authMiddleware, (req, res) => {
  if (!requireMapDM(req, res, req.params.id)) return
  const floor = db.prepare('SELECT id FROM floors WHERE id=? AND table_id=?').get(req.params.floorId, req.params.id)
  if (!floor) { res.status(404).json({ error: 'floor not found' }); return }

  const wallBody = (Array.isArray(req.body.walls) ? req.body.walls : []) as Array<Record<string, unknown>>
  const portalBody = (Array.isArray(req.body.portals) ? req.body.portals : []) as Array<Record<string, unknown>>
  const stairBody = (Array.isArray(req.body.stairs) ? req.body.stairs : []) as Array<Record<string, unknown>>
  const propBody = (Array.isArray(req.body.props) ? req.body.props : []) as Array<Record<string, unknown>>
  // Ids: keep the snapshot's id when present and well-formed, else new.
  const cleanId = (v: unknown) => (typeof v === 'string' && /^[a-f0-9]{8,32}$/.test(v) ? v : newId())
  const strField = (v: unknown) => (typeof v === 'string' ? v : '')

  const delWalls = db.prepare('DELETE FROM walls WHERE table_id=? AND floor_id=?')
  const delPortals = db.prepare('DELETE FROM portals WHERE table_id=? AND floor_id=?')
  const delStairs = db.prepare('DELETE FROM stairs WHERE table_id=? AND from_floor=?')
  const delProps = db.prepare('DELETE FROM props WHERE table_id=? AND floor_id=?')
  const insWall = db.prepare('INSERT INTO walls (id, table_id, floor_id, ax, ay, bx, by, group_id) VALUES (?,?,?,?,?,?,?,?)')
  const insPortal = db.prepare('INSERT INTO portals (id, table_id, x1, y1, x2, y2, closed, floor_id, kind, locked) VALUES (?,?,?,?,?,?,?,?,?,?)')
  const insStair = db.prepare('INSERT INTO stairs (id, table_id, from_floor, from_x, from_y, to_floor, to_x, to_y, radius) VALUES (?,?,?,?,?,?,?,?,?)')
  const insProp = db.prepare('INSERT INTO props (id, table_id, floor_id, asset_path, name, x, y, size, rotation, z, opacity, group_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
  const floorExists = db.prepare('SELECT id FROM floors WHERE id=? AND table_id=?')
  let stairCount = 0
  const insertWalls = () => {
    for (const w of wallBody) {
      const g = coerceWallBody(w)
      if (g) insWall.run(cleanId(w.id), req.params.id, req.params.floorId, g.ax, g.ay, g.bx, g.by, strField(w.group_id))
    }
  }
  const insertPortals = () => {
    for (const p of portalBody) {
      const g = coercePortalBody(p)
      if (g) insPortal.run(cleanId(p.id), req.params.id, g.x1, g.y1, g.x2, g.y2, g.closed ? 1 : 0, req.params.floorId, g.kind, g.locked ? 1 : 0)
    }
  }
  const insertStairs = () => {
    for (const s of stairBody) {
      const g = coerceStairRow(s, req.params.floorId, floorExists, req.params.id)
      if (!g) continue
      insStair.run(cleanId(s.id), req.params.id, req.params.floorId, g.fx, g.fy, g.toFloor, g.tx, g.ty, g.radius)
      stairCount++
    }
  }
  const insertProps = () => {
    for (const p of propBody) {
      const g = coercePropRow(p)
      if (!g) continue
      insProp.run(cleanId(p.id), req.params.id, req.params.floorId, g.assetPath, g.name, g.x, g.y, g.size, g.rotation, g.z, g.opacity, strField(p.group_id))
    }
  }
  db.transaction(() => {
    delWalls.run(req.params.id, req.params.floorId)
    delPortals.run(req.params.id, req.params.floorId)
    delStairs.run(req.params.id, req.params.floorId)
    delProps.run(req.params.id, req.params.floorId)
    insertWalls()
    insertPortals()
    insertStairs()
    insertProps()
  })()
  pushWalls(req.params.id)
  pushTableStateToTable(req.params.id)
  broadcastToTable(req.params.id, { type: 'props_update', payload: {} })
  res.json({ walls: wallBody.length, portals: portalBody.length, stairs: stairCount, props: propBody.length })
})

/** Snapshot stair row: validates floors + coordinates; null = skip row. */
function isStr(v: unknown): v is string { return typeof v === 'string' }
function coercePropRow(
  p: Record<string, unknown>,
): { assetPath: string; name: string; x: number; y: number; size: number; rotation: number; z: number; opacity: number } | null {
  const assetPath = isStr(p.asset_path) ? p.asset_path : ''
  if (!assetPath.startsWith('/uploads/')) return null
  const x = Number(p.x), y = Number(p.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return {
    assetPath,
    name: isStr(p.name) ? p.name.slice(0, 60) : 'prop',
    x, y,
    size: Number(p.size) > 0 ? Number(p.size) : 70,
    rotation: Number.isFinite(Number(p.rotation)) ? Number(p.rotation) : 0,
    z: Math.trunc(Number(p.z) || 0),
    opacity: Number(p.opacity) > 0 ? Number(p.opacity) : 1,
  }
}
function coerceStairRow(
  s: Record<string, unknown>,
  floorId: string,
  floorExists: { get(id: string, tableId: string): unknown },
  tableId: string,
): { fx: number; fy: number; toFloor: string; tx: number; ty: number; radius: number } | null {
  const fromFloor = isStr(s.from_floor) ? s.from_floor : floorId
  const toFloor = isStr(s.to_floor) ? s.to_floor : ''
  const fx = Number(s.from_x), fy = Number(s.from_y), tx = Number(s.to_x), ty = Number(s.to_y)
  if (![fx, fy, tx, ty].every(Number.isFinite)) return null
  if (fromFloor !== floorId) return null
  if (!floorExists.get(toFloor, tableId)) return null
  return { fx, fy, toFloor, tx, ty, radius: Number(s.radius) || 1 }
}

/** Snapshot portal row (world px endpoints + open/closed + kind + lock). */
interface PortalBody { x1: number; y1: number; x2: number; y2: number; closed: boolean; kind: 'door' | 'window'; locked: boolean }

function coercePortalBody(b: Record<string, unknown>): PortalBody | null {
  const x1 = Number(b.x1), y1 = Number(b.y1), x2 = Number(b.x2), y2 = Number(b.y2)
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null
  return {
    x1, y1, x2, y2,
    closed: b.closed === true || b.closed === 1,
    kind: b.kind === 'window' ? 'window' : 'door',
    locked: b.locked === true || b.locked === 1,
  }
}
