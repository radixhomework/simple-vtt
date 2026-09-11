/**
 * Token CRUD + fog points. Hidden tokens are withheld from players at this
 * layer (list) and in the hub (live updates), so their position can never
 * reach a player's browser.
 */
import { Router } from 'express'
import { db } from '../db'
import { authMiddleware } from '../auth'
import { requireMapDM, isMapDM, param } from '../mapaccess'
import { pushTableStateToTable } from '../hub'
import path from 'node:path'
import fs from 'node:fs'

export const tokensRouter = Router()

/** All entity ids are 16 hex chars — rejects '..' and any path tricks. */
const ID_RE = /^[a-f0-9]{16}$/
const uploadsRoot = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'))
const fogMaskFile = (floorId: string) => path.join(uploadsRoot, `fog_${floorId}.png`)
/**
 * Containment guard: resolve the final path and verify it stays inside the
 * uploads root (CodeQL S5780 / path-traversal barrier, belt and braces with
 * the ID_RE check).
 */
const safeMaskPath = (floorId: string): string | null => {
  if (!ID_RE.test(floorId)) return null
  const p = path.resolve(fogMaskFile(floorId))
  return p.startsWith(uploadsRoot + path.sep) ? p : null
}
const MAX_MASK_BYTES = 21079040

/** GET the persisted reveal mask of a floor (404 when none yet). */
tokensRouter.get('/floors/:id/fog-mask', authMiddleware, (req, res) => {
  const p = safeMaskPath(param(req, 'id'))
  if (!p) { res.status(400).json({ error: 'invalid floor id' }); return }
  if (!fs.existsSync(p)) { res.status(404).end(); return }
  res.sendFile(p)
})

/** PUT the reveal mask (dm only). Parsed with busboy so the request size
 *  limit is explicit and enforced on the stream (Sonar S5693). */
tokensRouter.put('/floors/:id/fog-mask', authMiddleware, (req, res) => {
  const floorId = param(req, 'id')
  const p = safeMaskPath(floorId)
  if (!p) { res.status(400).json({ error: 'invalid floor id' }); return }
  if (!requireMapDM(req, res, floorId)) return

  const MAX_MASK_BYTES = 21079040 // 20 MB + 4 KB headers allowance
  const declared = Number(req.headers['content-length'] ?? '0')
  if (!Number.isFinite(declared) || declared <= 0 || declared > MAX_MASK_BYTES) {
    res.status(413).json({ error: 'mask size out of bounds' }); return
  }

  // Collect the raw body (capped) and extract the single 'mask' file part.
  // Express 5 + busboy in this container never emitted parse events, so the
  // well-defined multipart format our client produces is parsed directly.
  const chunks: Buffer[] = []
  let total = 0
  let aborted = false
  req.on('data', (c: Buffer) => {
    total += c.length
    if (total > MAX_MASK_BYTES) {
      aborted = true
      req.destroy()
      return
    }
    chunks.push(c)
  })
  req.on('end', () => {
    if (aborted) { res.status(413).json({ error: 'mask size out of bounds' }); return }
    const body = Buffer.concat(chunks)
    const ct = String(req.headers['content-type'] ?? '')
    const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct)
    if (!bm) { res.status(400).json({ error: 'no multipart boundary' }); return }
    const boundary = Buffer.from('--' + (bm[1] ?? bm[2]))
    const partStart = body.indexOf(boundary)
    if (partStart === -1) { res.status(400).json({ error: 'malformed multipart body' }); return }
    const CRLF = String.fromCodePoint(13, 10)
    const headerEnd = body.indexOf(CRLF, partStart)
    if (headerEnd === -1) { res.status(400).json({ error: 'malformed part headers' }); return }
    const nextB = body.indexOf(Buffer.concat([Buffer.from(CRLF), boundary]), headerEnd)
    if (nextB === -1) { res.status(400).json({ error: 'unterminated part' }); return }

    const file = body.subarray(headerEnd + 4, nextB)
    fs.writeFileSync(p, file)
    res.sendStatus(204)
  })
})

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
  const rows = db.prepare(`SELECT ${TOKEN_COLS} FROM tokens WHERE table_id=?`).all(param(req, 'id')) as Array<Record<string, unknown>>
  // Hidden tokens are invisible to map players — withhold them entirely
  const visible = isMapDM(res.locals.user, param(req, 'id'), res.locals.role)
    ? rows
    : rows.filter(t => t.hidden !== 1)
  res.json(visible.map(normalizeToken))
})

tokensRouter.post('/tables/:id/tokens', authMiddleware, (req, res) => {
  if (!requireMapDM(req, res)) return
  const { name = '', x = 0, y = 0, icon_path = '', has_vision = false, vision_radius = 6, size = 0.75, color = '#4a90d9', owner = '', hidden = false } = req.body
  // Tokens live on a floor of the table (default: lowest level)
  const floor = (req.body.floor_id
    ? db.prepare('SELECT id FROM floors WHERE id=? AND table_id=?').get(req.body.floor_id, param(req, 'id'))
    : db.prepare('SELECT id FROM floors WHERE table_id=? ORDER BY level, rowid LIMIT 1').get(param(req, 'id'))
  ) as { id: string } | undefined
  if (!floor) { res.status(404).json({ error: 'floor not found' }); return }
  const id = newId()
  db.prepare('INSERT INTO tokens (id, table_id, name, x, y, icon_path, has_vision, vision_radius, size, color, owner, hidden, floor_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, param(req, 'id'), name, x, y, icon_path, has_vision ? 1 : 0, vision_radius, size, color, owner, hidden ? 1 : 0, floor.id)
  const row = db.prepare(`SELECT ${TOKEN_COLS} FROM tokens WHERE id=?`).get(id) as Record<string, unknown>
  res.status(201).json(normalizeToken(row))
})

tokensRouter.put('/tables/:id/tokens/:tokenId', authMiddleware, (req, res) => {
  const existing = db.prepare(
    `SELECT ${TOKEN_COLS} FROM tokens WHERE id=? AND table_id=?`
  ).get(param(req, 'tokenId'), param(req, 'id')) as Record<string, unknown> | undefined

  if (!existing) { res.status(404).json({ error: 'not found' }); return }

  // Authorization: map dms may edit anything; players only their own tokens,
  // and cannot change owner/hidden (dm-only controls).
  const isAdmin = isMapDM(res.locals.user, param(req, 'id'), res.locals.role)
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
    const floor = db.prepare('SELECT id FROM floors WHERE id=? AND table_id=?').get(b.floor_id, param(req, 'id'))
    if (!floor) { res.status(404).json({ error: 'floor not found' }); return }
    merged.floor_id = b.floor_id
  }

  db.prepare(
    'UPDATE tokens SET name=?, x=?, y=?, icon_path=?, has_vision=?, vision_radius=?, size=?, color=?, owner=?, hidden=?, floor_id=? WHERE id=? AND table_id=?'
  ).run(merged.name, merged.x, merged.y, merged.icon_path, merged.has_vision ? 1 : 0, merged.vision_radius, merged.size, merged.color, merged.owner, merged.hidden ? 1 : 0, merged.floor_id, param(req, 'tokenId'), param(req, 'id'))

  // Visibility changes must reach players even though the client follows up
  // with a WS token_update (by then the DB is already updated, so the hub's
  // own change detection would see no difference).
  const hiddenBool = (v: unknown) => v === 1 || v === true
  const hiddenChanged = hiddenBool(existing.hidden) !== hiddenBool(merged.hidden)
  const floorChanged = merged.floor_id !== existing.floor_id
  if (hiddenChanged || floorChanged) {
    pushTableStateToTable(param(req, 'id'))
  }

  const row = db.prepare(
    `SELECT ${TOKEN_COLS} FROM tokens WHERE id=?`
  ).get(param(req, 'tokenId')) as Record<string, unknown>
  res.json(normalizeToken(row))
})

tokensRouter.delete('/tables/:id/tokens/:tokenId', authMiddleware, (req, res) => {
  if (!requireMapDM(req, res)) return
  db.prepare('DELETE FROM tokens WHERE id=? AND table_id=?').run(param(req, 'tokenId'), param(req, 'id'))
  res.sendStatus(204)
})

// ── Fog points ────────────────────────────────────────────────────────────────
tokensRouter.get('/tables/:id/fog', authMiddleware, (req, res) => {
  const floor = typeof req.query.floor_id === 'string' ? req.query.floor_id : null
  res.json(floor
    ? db.prepare('SELECT id, table_id, x, y, radius, floor_id FROM fog_points WHERE table_id=? AND floor_id=?').all(param(req, 'id'), floor)
    : db.prepare('SELECT id, table_id, x, y, radius, floor_id FROM fog_points WHERE table_id=?').all(param(req, 'id')))
})

tokensRouter.post('/tables/:id/fog', authMiddleware, (req, res) => {
  if (!requireMapDM(req, res)) return
  const { x, y, radius = 3, floor_id } = req.body
  const id = newId()
  db.prepare('INSERT INTO fog_points (id, table_id, x, y, radius, floor_id) VALUES (?,?,?,?,?,?)')
    .run(id, param(req, 'id'), x, y, radius, floor_id ?? '')
  res.status(201).json({ id, table_id: param(req, 'id'), x, y, radius, floor_id: floor_id ?? '' })
})

tokensRouter.delete('/tables/:id/fog', authMiddleware, (req, res) => {
  if (!requireMapDM(req, res)) return
  // ?floor_id= scopes the clear to one level; without it, all floors
  const floor = typeof req.query.floor_id === 'string' ? req.query.floor_id : null
  if (floor) db.prepare('DELETE FROM fog_points WHERE table_id=? AND floor_id=?').run(param(req, 'id'), floor)
  else db.prepare('DELETE FROM fog_points WHERE table_id=?').run(param(req, 'id'))
  res.sendStatus(204)
})
