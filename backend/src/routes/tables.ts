/**
 * Table + floor CRUD, UVTT import (extracts the map image, grid size and
 * portals from Universal VTT files) and stairs between floors.
 *
 * Multi-level model: a table owns floors (levels); tokens, portals, fog
 * points and stairs all reference a floor. Floor images of one table must
 * share identical dimensions, enforced here, so a single coordinate space
 * serves every level.
 */
import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import AdmZip from 'adm-zip'
import { db } from '../db'
import { authMiddleware } from '../auth'
import { decodeUploadFilename } from '../filename'
import { pushTableStateToTable, broadcastToTable } from '../hub'
import { loadTableSettings, sanitizeTableSettingsPatch } from '../settings'
import { buildTilePyramid, deleteTilePyramid } from '../tiles'
import { mapRole, requireMapDM, requireMapAccess } from '../mapaccess'

export const tablesRouter = Router()

const uploadsDir = () => process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')

const storage = multer.memoryStorage()
const upload = multer({ storage, limits: { fileSize: 150 * 1024 * 1024 } })

function newId(): string { return crypto.randomUUID().replace(/-/g, '').slice(0, 16) }

const TABLE_COLS = 'id, name, owner, default_floor_id'
const FLOOR_COLS = 'id, table_id, level, name, map_image_path, grid_size, uvt_metadata, map_offset_x, map_offset_y, img_width, img_height, tiles_path'

interface FloorRow {
  id: string; table_id: string; level: number; name: string
  map_image_path: string; grid_size: number; uvt_metadata: string
  map_offset_x: number; map_offset_y: number; img_width: number; img_height: number
  tiles_path: string
}

function getTable(id: string) {
  return db.prepare(`SELECT ${TABLE_COLS} FROM tables WHERE id=?`).get(id) as { id: string; name: string; owner: string; default_floor_id: string } | undefined
}

function getFloor(id: string) {
  return db.prepare(`SELECT ${FLOOR_COLS} FROM floors WHERE id=?`).get(id) as FloorRow | undefined
}

function floorsOf(tableId: string) {
  return db.prepare(`SELECT ${FLOOR_COLS} FROM floors WHERE table_id=? ORDER BY level, rowid`).all(tableId) as FloorRow[]
}

/**
 * The dimension reference of a table: the lowest floor with a known image
 * size. Returns null while no floor declares one (legacy data), in which
 * case the check is skipped.
 */
function dimensionRef(tableId: string): { w: number; h: number } | null {
  const row = db.prepare(
    'SELECT img_width AS w, img_height AS h FROM floors WHERE table_id=? AND img_width>0 AND img_height>0 ORDER BY level, rowid LIMIT 1'
  ).get(tableId) as { w: number; h: number } | undefined
  return row ? { w: row.w, h: row.h } : null
}

/** All floor images must share dimensions so coordinates map 1:1 across levels. */
function checkDimensions(tableId: string, w: number, h: number): string | null {
  if (!w || !h) return null // unknown → nothing to compare against
  const ref = dimensionRef(tableId)
  if (ref && (ref.w !== w || ref.h !== h)) {
    return `floor images must all be ${ref.w}×${ref.h}px (got ${w}×${h})`
  }
  return null
}

// ── Tables ────────────────────────────────────────────────────────────────────
tablesRouter.get('/tables', authMiddleware, (req, res) => {
    // Users see the maps they can reach (uploaded or invited); admins see
    // everything through the console.
    const rows = res.locals.role === 'admin'
      ? db.prepare(`
          SELECT t.id, t.name, t.owner,
            (SELECT COUNT(*) FROM floors  WHERE table_id = t.id) AS floor_count,
            (SELECT COUNT(*) FROM floors  WHERE table_id = t.id AND map_image_path <> '') AS image_count,
            (SELECT COUNT(*) FROM tokens  WHERE table_id = t.id) AS token_count,
            (SELECT COUNT(*) FROM portals WHERE table_id = t.id) AS portal_count
          FROM tables t ORDER BY t.rowid DESC
        `).all() as Array<Record<string, unknown>>
      : db.prepare(`
          SELECT t.id, t.name, t.owner,
            (SELECT COUNT(*) FROM floors  WHERE table_id = t.id) AS floor_count,
            (SELECT COUNT(*) FROM floors  WHERE table_id = t.id AND map_image_path <> '') AS image_count,
            (SELECT COUNT(*) FROM tokens  WHERE table_id = t.id) AS token_count,
            (SELECT COUNT(*) FROM portals WHERE table_id = t.id) AS portal_count
          FROM tables t JOIN map_members m ON m.table_id = t.id
          WHERE m.username = ? ORDER BY t.rowid DESC
        `).all(res.locals.user) as Array<Record<string, unknown>>
    const withRole = rows.map(t => ({ ...t, my_role: mapRole(res.locals.user, t.id as string, res.locals.role) }))
    res.json(withRole)
  })

tablesRouter.post('/tables', authMiddleware, (req, res) => {
  const { name, grid_size = 70 } = req.body
  if (!name) { res.status(400).json({ error: 'name required' }); return }
  const id = newId()
  db.transaction(() => {
    db.prepare('INSERT INTO tables (id, name, owner) VALUES (?,?,?)').run(id, name, res.locals.user)
    db.prepare('INSERT INTO floors (id, table_id, level, name, grid_size) VALUES (?,?,1,?,?)').run(newId(), id, '', grid_size)
    db.prepare("INSERT INTO map_members (table_id, username, role) VALUES (?,?,'dm')").run(id, res.locals.user)
  })()
  res.status(201).json(getTable(id))
})

tablesRouter.get('/tables/:id', authMiddleware, (req, res) => {
  if (!requireMapAccess(req, res)) return
  const t = getTable(req.params.id)
  if (!t) { res.status(404).json({ error: 'not found' }); return }
  res.json({ ...t, floors: floorsOf(req.params.id), my_role: mapRole(res.locals.user, req.params.id, res.locals.role) })
})

tablesRouter.put('/tables/:id', authMiddleware, (req, res) => {
  if (!requireMapDM(req, res)) return
  const existing = getTable(req.params.id)
  if (!existing) { res.status(404).json({ error: 'not found' }); return }
  const name = req.body.name !== undefined ? req.body.name : existing.name

  // Per-map default floor: must be a floor of this table ('' = lowest)
  let defaultFloorId = existing.default_floor_id ?? ''
  if (req.body.default_floor_id !== undefined) {
    const wanted = String(req.body.default_floor_id)
    if (wanted === '') defaultFloorId = ''
    else {
      const floor = db.prepare('SELECT id FROM floors WHERE id=? AND table_id=?').get(wanted, req.params.id)
      if (!floor) { res.status(404).json({ error: 'floor not found' }); return }
      defaultFloorId = wanted
    }
  }

  db.prepare('UPDATE tables SET name=?, default_floor_id=? WHERE id=?').run(name, defaultFloorId, req.params.id)
  res.json(getTable(req.params.id))
})

tablesRouter.delete('/tables/:id', authMiddleware, (req, res) => {
  if (!requireMapDM(req, res)) return
  // Free the floors' tile pyramids (and their images) before the rows go
  for (const f of floorsOf(req.params.id)) {
    if (f.tiles_path) deleteTilePyramid(f.id)
    if (f.map_image_path) {
      try { fs.unlinkSync(path.join(uploadsDir(), path.basename(f.map_image_path))) } catch { /* gone */ }
    }
  }
  db.prepare('DELETE FROM floors WHERE table_id=?').run(req.params.id) // cascades nothing; children follow below
  db.prepare('DELETE FROM tokens WHERE table_id=?').run(req.params.id)
  db.prepare('DELETE FROM portals WHERE table_id=?').run(req.params.id)
  db.prepare('DELETE FROM fog_points WHERE table_id=?').run(req.params.id)
  db.prepare('DELETE FROM stairs WHERE table_id=?').run(req.params.id)
  db.prepare('DELETE FROM tables WHERE id=?').run(req.params.id)
  res.sendStatus(204)
})

// ── Map members (invitations) ─────────────────────────────────────────────────
tablesRouter.get('/tables/:id/members', authMiddleware, (req, res) => {
  if (!requireMapDM(req, res)) return
  res.json(db.prepare('SELECT username, role FROM map_members WHERE table_id=? ORDER BY role, username').all(req.params.id))
})

tablesRouter.post('/tables/:id/members', authMiddleware, (req, res) => {
  if (!requireMapDM(req, res)) return
  const { username, role } = req.body as { username?: string; role?: string }
  if (!username || (role !== 'dm' && role !== 'player')) { res.status(400).json({ error: 'username and role (dm|player) required' }); return }
  const user = db.prepare('SELECT username FROM users WHERE username=?').get(username)
  if (!user) { res.status(404).json({ error: 'unknown user' }); return }
  db.prepare('INSERT INTO map_members (table_id, username, role) VALUES (?,?,?) ON CONFLICT(table_id, username) DO UPDATE SET role=excluded.role')
    .run(req.params.id, username, role)
  res.status(201).json({ username, role })
})

tablesRouter.delete('/tables/:id/members/:username', authMiddleware, (req, res) => {
  if (!requireMapDM(req, res)) return
  const table = getTable(req.params.id)
  if (req.params.username === table?.owner) { res.status(409).json({ error: 'the map owner cannot be removed' }); return }
  const r = db.prepare('DELETE FROM map_members WHERE table_id=? AND username=?').run(req.params.id, req.params.username)
  if (r.changes === 0) { res.status(404).json({ error: 'not a member' }); return }
  res.sendStatus(204)
})

// ── Per-map settings ──────────────────────────────────────────────────────────
tablesRouter.get('/tables/:id/settings', authMiddleware, (req, res) => {
  const table = getTable(req.params.id)
  if (!table) { res.status(404).json({ error: 'not found' }); return }
  res.json(loadTableSettings(req.params.id))
})

tablesRouter.patch('/tables/:id/settings', authMiddleware, (req, res) => {
  if (!requireMapDM(req, res)) return
  const table = getTable(req.params.id)
  if (!table) { res.status(404).json({ error: 'not found' }); return }
  const patches = sanitizeTableSettingsPatch(req.body)
  if (Object.keys(patches).length === 0) { res.status(400).json({ error: 'nothing to update' }); return }
  const sets = Object.keys(patches).map(k => `${k}=?`).join(', ')
  db.prepare(`UPDATE tables SET ${sets} WHERE id=?`).run(...Object.values(patches), req.params.id)
  const settings = loadTableSettings(req.params.id)
  // Live sync for everyone viewing this map
  broadcastToTable(req.params.id, { type: 'settings_update', payload: { settings } })
  res.json(settings)
})

// ── Table import (UVTT/zip creates a new table with floor 1) ─────────────────
tablesRouter.post('/tables/import', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'no file' }); return }

  const ext = path.extname(decodeUploadFilename(req.file.originalname)).toLowerCase()
  let uvttJson: Record<string, unknown>
  let imageBuffer: Buffer | null = null
  let imageExt = '.png'

  try {
    if (ext === '.zip') {
      const zip = new AdmZip(req.file.buffer)
      const uvttEntry = zip.getEntries().find(e => /\.(uvtt|dd2vtt)$/i.test(e.name))
      const imgEntry = zip.getEntries().find(e => /\.(png|jpe?g|webp)$/i.test(e.name))
      if (!uvttEntry) { res.status(400).json({ error: 'no .uvtt file in zip' }); return }
      uvttJson = JSON.parse(uvttEntry.getData().toString('utf8'))
      if (imgEntry) {
        imageBuffer = imgEntry.getData()
        imageExt = path.extname(imgEntry.name).toLowerCase()
      }
    } else if (ext === '.uvtt' || ext === '.dd2vtt') {
      uvttJson = JSON.parse(req.file.buffer.toString('utf8'))
    } else {
      res.status(400).json({ error: 'unsupported file type' }); return
    }
  } catch (e: unknown) {
    res.status(400).json({ error: 'parse error: ' + (e as Error).message }); return
  }

  const resolution = uvttJson.resolution as Record<string, unknown> | undefined
  const gridSize = typeof resolution?.pixels_per_grid === 'number' ? Math.round(resolution.pixels_per_grid) : 70

  if (!imageBuffer && typeof uvttJson.image === 'string') {
    const raw = uvttJson.image as string
    if (raw.startsWith('data:')) {
      const [header, b64] = raw.split(',', 2)
      const mime = header.replace('data:', '').replace(';base64', '')
      imageExt = mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : '.png'
      imageBuffer = Buffer.from(b64, 'base64')
    } else {
      imageBuffer = Buffer.from(raw, 'base64')
    }
  }

  // UVTT stores the grid dimensions under resolution.map_size
  const mapSize = (resolution as Record<string, unknown> | undefined)?.map_size as { x?: number; y?: number } | undefined
  const imgW = typeof mapSize?.x === 'number' ? Math.round(mapSize.x * gridSize) : 0
  const imgH = typeof mapSize?.y === 'number' ? Math.round(mapSize.y * gridSize) : 0

  const tableId = newId()
  const floorId = newId()
  let imagePath = ''

  if (imageBuffer) {
    const dir = uploadsDir()
    fs.mkdirSync(dir, { recursive: true })
    const filename = `map_${floorId}${imageExt}`
    fs.writeFileSync(path.join(dir, filename), imageBuffer)
    imagePath = `/uploads/${filename}`
    // Tile pyramid for heavy-map clients; built async so the import
    // response isn't held up. On failure the floor keeps its full image
    // (legacy path) — tiling is an optimization, never a blocker.
    buildTilePyramid(floorId, imageBuffer)
      .then(() => {
        db.prepare('UPDATE floors SET tiles_path=? WHERE id=?').run(`/uploads/tiles/${floorId}`, floorId)
        pushTableStateToTable(tableId)
      })
      .catch(err => console.error(`[tiles] pyramid build failed for floor ${floorId}:`, err))
  }

  const tableName = req.body.name || path.basename(decodeUploadFilename(req.file.originalname), ext)
  const meta = JSON.stringify(uvttJson)

  const insertAll = db.transaction(() => {
    db.prepare('INSERT INTO tables (id, name, owner) VALUES (?,?,?)').run(tableId, tableName, res.locals.user)
    db.prepare("INSERT INTO map_members (table_id, username, role) VALUES (?,?,'dm')").run(tableId, res.locals.user)
    db.prepare(
      `INSERT INTO floors (id, table_id, level, name, map_image_path, grid_size, uvt_metadata, img_width, img_height)
       VALUES (?,?,1,'',?,?,?,?,?)`
    ).run(floorId, tableId, imagePath, gridSize, meta, imgW, imgH)

    // Extract portals (doors/windows) onto floor 1
    if (Array.isArray(uvttJson.portals)) {
      const insertPortal = db.prepare('INSERT INTO portals (id, table_id, x1, y1, x2, y2, closed, floor_id, kind) VALUES (?,?,?,?,?,?,?,?,?)')
      for (const portal of uvttJson.portals as Array<Record<string, unknown>>) {
        const bounds = portal.bounds as Array<{ x: number; y: number }> | undefined
        if (!bounds || bounds.length < 2) continue
        const p1 = bounds[0], p2 = bounds[bounds.length - 1]
        // Some exporters mark windows explicitly; unmarked portals are doors
        const kind = portal.window === true || portal.kind === 'window' || portal.type === 'window'
          ? 'window' : 'door'
        insertPortal.run(
          newId(), tableId,
          p1.x * gridSize, p1.y * gridSize,
          p2.x * gridSize, p2.y * gridSize,
          portal.closed !== false ? 1 : 0,   // default closed unless explicitly open
          floorId,
          kind,
        )
      }
    }
  })
  insertAll()

  res.status(201).json({ ...getTable(tableId), floors: floorsOf(tableId), my_role: mapRole(res.locals.user, tableId, res.locals.role) })
})

// ── Floors ────────────────────────────────────────────────────────────────────
/** Create an empty floor at the next level. */
tablesRouter.post('/tables/:id/floors', authMiddleware, (req, res) => {
  if (!requireMapDM(req, res)) return
  const table = getTable(req.params.id)
  if (!table) { res.status(404).json({ error: 'not found' }); return }
  const { name = '', grid_size } = req.body
  const ref = floorsOf(req.params.id)
  const level = (ref.at(-1)?.level ?? 0) + 1
  const size = grid_size ?? ref[0]?.grid_size ?? 70
  const id = newId()
  db.prepare('INSERT INTO floors (id, table_id, level, name, grid_size) VALUES (?,?,?,?,?)')
    .run(id, req.params.id, level, name, size)
  res.status(201).json(getFloor(id))
})

/** Import a UVTT/zip as a new floor (map + walls + portals). */
tablesRouter.post('/tables/:id/floors/import', authMiddleware, upload.single('file'), (req, res) => {
  if (!requireMapDM(req, res)) return
  if (!req.file) { res.status(400).json({ error: 'no file' }); return }
  const table = getTable(req.params.id)
  if (!table) { res.status(404).json({ error: 'not found' }); return }

  const ext = path.extname(decodeUploadFilename(req.file.originalname)).toLowerCase()
  let uvttJson: Record<string, unknown>
  let imageBuffer: Buffer | null = null
  let imageExt = '.png'

  try {
    if (ext === '.zip') {
      const zip = new AdmZip(req.file.buffer)
      const uvttEntry = zip.getEntries().find(e => /\.(uvtt|dd2vtt)$/i.test(e.name))
      const imgEntry = zip.getEntries().find(e => /\.(png|jpe?g|webp)$/i.test(e.name))
      if (!uvttEntry) { res.status(400).json({ error: 'no .uvtt file in zip' }); return }
      uvttJson = JSON.parse(uvttEntry.getData().toString('utf8'))
      if (imgEntry) {
        imageBuffer = imgEntry.getData()
        imageExt = path.extname(imgEntry.name).toLowerCase()
      }
    } else if (ext === '.uvtt' || ext === '.dd2vtt') {
      uvttJson = JSON.parse(req.file.buffer.toString('utf8'))
    } else {
      res.status(400).json({ error: 'unsupported file type' }); return
    }
  } catch (e: unknown) {
    res.status(400).json({ error: 'parse error: ' + (e as Error).message }); return
  }

  const resolution = uvttJson.resolution as Record<string, unknown> | undefined
  const gridSize = typeof resolution?.pixels_per_grid === 'number' ? Math.round(resolution.pixels_per_grid) : 70

  if (!imageBuffer && typeof uvttJson.image === 'string') {
    const raw = uvttJson.image as string
    if (raw.startsWith('data:')) {
      const [header, b64] = raw.split(',', 2)
      const mime = header.replace('data:', '').replace(';base64', '')
      imageExt = mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : '.png'
      imageBuffer = Buffer.from(b64, 'base64')
    } else {
      imageBuffer = Buffer.from(raw, 'base64')
    }
  }

  // UVTT declares its size in grid cells — enforce the same-dimensions rule
  // UVTT stores the grid dimensions under resolution.map_size
  const mapSize = (resolution as Record<string, unknown> | undefined)?.map_size as { x?: number; y?: number } | undefined
  if (typeof mapSize?.x === 'number' && typeof mapSize?.y === 'number') {
    const dimError = checkDimensions(req.params.id, mapSize.x * gridSize, mapSize.y * gridSize)
    if (dimError) { res.status(409).json({ error: dimError }); return }
  }

  const existing = floorsOf(req.params.id)
  const level = (existing.at(-1)?.level ?? 0) + 1
  const name = String(req.body.name ?? '')
  const floorId = newId()
  let imagePath = ''
  let imgW = 0, imgH = 0
  if (typeof mapSize?.x === 'number' && typeof mapSize?.y === 'number') {
    imgW = Math.round(mapSize.x * gridSize)
    imgH = Math.round(mapSize.y * gridSize)
  }

  if (imageBuffer) {
    const dir = uploadsDir()
    fs.mkdirSync(dir, { recursive: true })
    const filename = `map_${floorId}${imageExt}`
    fs.writeFileSync(path.join(dir, filename), imageBuffer)
    imagePath = `/uploads/${filename}`
    // Same async pyramid build as the table import above
    buildTilePyramid(floorId, imageBuffer)
      .then(() => {
        db.prepare('UPDATE floors SET tiles_path=? WHERE id=?').run(`/uploads/tiles/${floorId}`, floorId)
        pushTableStateToTable(req.params.id)
      })
      .catch(err => console.error(`[tiles] pyramid build failed for floor ${floorId}:`, err))
  }

  const meta = JSON.stringify(uvttJson)
  db.transaction(() => {
    db.prepare(
      `INSERT INTO floors (id, table_id, level, name, map_image_path, grid_size, uvt_metadata, img_width, img_height)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(floorId, req.params.id, level, name, imagePath, gridSize, meta, imgW, imgH)

    if (Array.isArray(uvttJson.portals)) {
      const insertPortal = db.prepare('INSERT INTO portals (id, table_id, x1, y1, x2, y2, closed, floor_id, kind) VALUES (?,?,?,?,?,?,?,?,?)')
      for (const portal of uvttJson.portals as Array<Record<string, unknown>>) {
        const bounds = portal.bounds as Array<{ x: number; y: number }> | undefined
        if (!bounds || bounds.length < 2) continue
        const p1 = bounds[0], p2 = bounds[bounds.length - 1]
        // Some exporters mark windows explicitly; unmarked portals are doors
        const kind = portal.window === true || portal.kind === 'window' || portal.type === 'window'
          ? 'window' : 'door'
        insertPortal.run(
          newId(), req.params.id,
          p1.x * gridSize, p1.y * gridSize,
          p2.x * gridSize, p2.y * gridSize,
          portal.closed !== false ? 1 : 0,
          floorId,
          kind,
        )
      }
    }
  })()

  res.status(201).json(getFloor(floorId))
})

/** Reorder floors: the given id sequence becomes levels 1..N. */
tablesRouter.put('/tables/:id/floors/reorder', authMiddleware, (req, res) => {
  if (!requireMapDM(req, res)) return
  const { floor_ids } = req.body as { floor_ids?: string[] }
  const floors = floorsOf(req.params.id)
  if (!Array.isArray(floor_ids) || floor_ids.length !== floors.length
      || !floors.every(f => floor_ids.includes(f.id)) || new Set(floor_ids).size !== floor_ids.length) {
    res.status(400).json({ error: 'floor_ids must list every floor of the table exactly once' })
    return
  }
  db.transaction(() => {
    const update = db.prepare('UPDATE floors SET level=? WHERE id=? AND table_id=?')
    floor_ids.forEach((id, i) => update.run(i + 1, id, req.params.id))
  })()
  // Connected clients see the new order in their floor switcher
  pushTableStateToTable(req.params.id)
  res.json(floorsOf(req.params.id))
})

/** Upload/replace the map image of a floor. Client sends width/height for the dimension check. */
tablesRouter.post('/floors/:id/upload-image', authMiddleware, upload.single('image'), (req, res) => {
  const floor = getFloor(req.params.id)
  if (!floor) { res.status(404).json({ error: 'floor not found' }); return }
  if (!requireMapDM(req, res, floor.table_id)) return
  if (!req.file) { res.status(400).json({ error: 'no file' }); return }
  const w = parseInt(String(req.body.width ?? '0')) || 0
  const h = parseInt(String(req.body.height ?? '0')) || 0
  const dimError = checkDimensions(floor.table_id, w, h)
  if (dimError) { res.status(409).json({ error: dimError }); return }
  const ext = path.extname(decodeUploadFilename(req.file.originalname)).toLowerCase() || '.png'
  const dir = uploadsDir()
  fs.mkdirSync(dir, { recursive: true })
  // Unique filename per upload: browsers cache /uploads immutably, so a
  // replaced image must live at a fresh URL or clients would keep the old one
  const filename = `map_${floor.id}_${Date.now().toString(36)}${ext}`
  // Drop the superseded bitmap (extension may have changed, hence the guard)
  const prevFile = floor.map_image_path ? path.basename(floor.map_image_path) : ''
  if (prevFile && prevFile !== filename) {
    try { fs.unlinkSync(path.join(dir, prevFile)) } catch { /* already gone */ }
  }
  fs.writeFileSync(path.join(dir, filename), req.file.buffer)
  const imagePath = `/uploads/${filename}`
  db.prepare('UPDATE floors SET map_image_path=?, img_width=?, img_height=? WHERE id=?')
    .run(imagePath, w, h, floor.id)
  // Rebuild the tile pyramid from the new image (replaces the old files)
  buildTilePyramid(floor.id, req.file.buffer)
    .then(() => {
      db.prepare('UPDATE floors SET tiles_path=? WHERE id=?').run(`/uploads/tiles/${floor.id}`, floor.id)
      pushTableStateToTable(floor.table_id)
    })
    .catch(err => console.error(`[tiles] pyramid rebuild failed for floor ${floor.id}:`, err))
  res.json({ path: imagePath, width: w, height: h })
})

tablesRouter.put('/floors/:id', authMiddleware, (req, res) => {
  const floor = getFloor(req.params.id)
  if (!floor) { res.status(404).json({ error: 'not found' }); return }
  if (!requireMapDM(req, res, floor.table_id)) return
  const b = req.body
  const merged = {
    name:           b.name           !== undefined ? String(b.name)          : floor.name,
    grid_size:      b.grid_size      !== undefined ? b.grid_size             : floor.grid_size,
    map_offset_x:   b.map_offset_x   !== undefined ? b.map_offset_x          : floor.map_offset_x,
    map_offset_y:   b.map_offset_y   !== undefined ? b.map_offset_y          : floor.map_offset_y,
  }
  db.prepare('UPDATE floors SET name=?, grid_size=?, map_offset_x=?, map_offset_y=? WHERE id=?')
    .run(merged.name, merged.grid_size, merged.map_offset_x, merged.map_offset_y, floor.id)
  // Grid/offset changes affect every client's rendering — resync them.
  pushTableStateToTable(floor.table_id)
  res.json(getFloor(floor.id))
})

tablesRouter.delete('/floors/:id', authMiddleware, (req, res) => {
  const floor = getFloor(req.params.id)
  if (!floor) { res.status(404).json({ error: 'not found' }); return }
  if (!requireMapDM(req, res, floor.table_id)) return
  const count = db.prepare('SELECT COUNT(*) AS n FROM floors WHERE table_id=?').get(floor.table_id) as { n: number }
  if (count.n <= 1) { res.status(409).json({ error: 'cannot delete the last floor' }); return }
  db.transaction(() => {
    db.prepare('DELETE FROM tokens WHERE floor_id=?').run(floor.id)
    db.prepare('DELETE FROM portals WHERE floor_id=?').run(floor.id)
    db.prepare('DELETE FROM fog_points WHERE floor_id=?').run(floor.id)
    db.prepare('DELETE FROM stairs WHERE from_floor=? OR to_floor=?').run(floor.id, floor.id)
    db.prepare('DELETE FROM floors WHERE id=?').run(floor.id)
  })()
  // Drop this floor's image and tile pyramid
  if (floor.tiles_path) deleteTilePyramid(floor.id)
  if (floor.map_image_path) {
    try { fs.unlinkSync(path.join(uploadsDir(), path.basename(floor.map_image_path))) } catch { /* gone */ }
  }
  res.sendStatus(204)
})

// ── Stairs (level links) & same-floor teleporters ─────────────────────────────
tablesRouter.post('/tables/:id/stairs', authMiddleware, (req, res) => {
  if (!requireMapDM(req, res)) return
  const { from_floor, from_x, from_y, to_floor, to_x, to_y, radius = 1 } = req.body
  const floors = floorsOf(req.params.id)
  const from = floors.find(f => f.id === from_floor)
  const to = floors.find(f => f.id === to_floor)
  if (!from || !to) { res.status(400).json({ error: 'both floors must belong to this table' }); return }
  // from == to is legal: that's a same-floor teleporter
  const id = newId()
  db.prepare('INSERT INTO stairs (id, table_id, from_floor, from_x, from_y, to_floor, to_x, to_y, radius) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, req.params.id, from_floor, from_x, from_y, to_floor, to_x, to_y, radius)
  res.status(201).json({ id, table_id: req.params.id, from_floor, from_x, from_y, to_floor, to_x, to_y, radius })
})

tablesRouter.delete('/stairs/:id', authMiddleware, (req, res) => {
  const stair = db.prepare('SELECT table_id FROM stairs WHERE id=?').get(req.params.id) as { table_id: string } | undefined
  if (!stair) { res.sendStatus(204); return }
  if (!requireMapDM(req, res, stair.table_id)) return
  db.prepare('DELETE FROM stairs WHERE id=?').run(req.params.id)
  res.sendStatus(204)
})

/** Edit a stair/teleporter: change destination floor (arrival keeps its
 *  point unless new coords given — same-floor targets are teleporters and
 *  legal) and/or move the source/destination points (build mode). */
tablesRouter.patch('/tables/:id/stairs/:stairId', authMiddleware, (req, res) => {
  if (!requireMapDM(req, res)) return
  const b = req.body as Record<string, unknown>
  const stair = db.prepare('SELECT id, table_id, from_floor, from_x, from_y, to_floor, to_x, to_y, radius FROM stairs WHERE id=? AND table_id=?')
    .get(req.params.stairId, req.params.id) as Record<string, unknown> | undefined
  if (!stair) { res.status(404).json({ error: 'not found' }); return }

  let { to_floor, to_x, to_y } = stair
  if (b.to_floor !== undefined) {
    const target = floorsOf(req.params.id).find(f => f.id === b.to_floor)
    if (!target) { res.status(400).json({ error: 'destination must be a floor of this table' }); return }
    to_floor = target.id as string
    // Same-floor destination = teleporter (legal). Arrival defaults to the
    // source point; explicit to_x/to_y override it.
    if (to_x === undefined || b.to_x === undefined) to_x = b.to_x !== undefined ? Number(b.to_x) : stair.from_x
    if (to_y === undefined || b.to_y !== undefined) to_y = b.to_y !== undefined ? Number(b.to_y) : stair.from_y
  }
  const from_x = b.from_x !== undefined ? Number(b.from_x) : stair.from_x
  const from_y = b.from_y !== undefined ? Number(b.from_y) : stair.from_y
  if (b.to_x !== undefined) to_x = Number(b.to_x)
  if (b.to_y !== undefined) to_y = Number(b.to_y)
  if (![from_x, from_y, to_x, to_y].every(Number.isFinite)) {
    res.status(400).json({ error: 'finite coordinates required' }); return
  }

  db.prepare('UPDATE stairs SET from_x=?, from_y=?, to_floor=?, to_x=?, to_y=? WHERE id=?')
    .run(from_x, from_y, to_floor, to_x, to_y, req.params.stairId)
  pushTableStateToTable(req.params.id)
  const fresh = db.prepare('SELECT id, table_id, from_floor, from_x, from_y, to_floor, to_x, to_y, radius FROM stairs WHERE id=?')
    .get(req.params.stairId)
  res.json(fresh)
})
