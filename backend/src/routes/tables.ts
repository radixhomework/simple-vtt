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
import { authMiddleware, adminOnly } from '../auth'
import { decodeUploadFilename } from '../filename'

export const tablesRouter = Router()

const uploadsDir = () => process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')

const storage = multer.memoryStorage()
const upload = multer({ storage, limits: { fileSize: 150 * 1024 * 1024 } })

function newId(): string { return crypto.randomUUID().replace(/-/g, '').slice(0, 16) }

const TABLE_COLS = 'id, name'
const FLOOR_COLS = 'id, table_id, level, name, map_image_path, grid_size, uvt_metadata, map_offset_x, map_offset_y, img_width, img_height'

interface FloorRow {
  id: string; table_id: string; level: number; name: string
  map_image_path: string; grid_size: number; uvt_metadata: string
  map_offset_x: number; map_offset_y: number; img_width: number; img_height: number
}

function getTable(id: string) {
  return db.prepare(`SELECT ${TABLE_COLS} FROM tables WHERE id=?`).get(id) as { id: string; name: string } | undefined
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
tablesRouter.get('/tables', authMiddleware, (_req, res) => {
  res.json(db.prepare(`
    SELECT t.id, t.name,
      (SELECT COUNT(*) FROM floors  WHERE table_id = t.id) AS floor_count,
      (SELECT COUNT(*) FROM tokens  WHERE table_id = t.id) AS token_count,
      (SELECT COUNT(*) FROM portals WHERE table_id = t.id) AS portal_count
    FROM tables t
  `).all())
})

tablesRouter.post('/tables', authMiddleware, adminOnly, (req, res) => {
  const { name, grid_size = 70 } = req.body
  if (!name) { res.status(400).json({ error: 'name required' }); return }
  const id = newId()
  db.transaction(() => {
    db.prepare('INSERT INTO tables (id, name) VALUES (?,?)').run(id, name)
    db.prepare('INSERT INTO floors (id, table_id, level, name, grid_size) VALUES (?,?,1,?,?)').run(newId(), id, '', grid_size)
  })()
  res.status(201).json(getTable(id))
})

tablesRouter.get('/tables/:id', authMiddleware, (req, res) => {
  const t = getTable(req.params.id)
  if (!t) { res.status(404).json({ error: 'not found' }); return }
  res.json({ ...t, floors: floorsOf(req.params.id) })
})

tablesRouter.put('/tables/:id', authMiddleware, adminOnly, (req, res) => {
  const existing = getTable(req.params.id)
  if (!existing) { res.status(404).json({ error: 'not found' }); return }
  const name = req.body.name !== undefined ? req.body.name : existing.name
  db.prepare('UPDATE tables SET name=? WHERE id=?').run(name, req.params.id)
  res.json(getTable(req.params.id))
})

tablesRouter.delete('/tables/:id', authMiddleware, adminOnly, (req, res) => {
  db.prepare('DELETE FROM floors WHERE table_id=?').run(req.params.id) // cascades nothing; children follow below
  db.prepare('DELETE FROM tokens WHERE table_id=?').run(req.params.id)
  db.prepare('DELETE FROM portals WHERE table_id=?').run(req.params.id)
  db.prepare('DELETE FROM fog_points WHERE table_id=?').run(req.params.id)
  db.prepare('DELETE FROM stairs WHERE table_id=?').run(req.params.id)
  db.prepare('DELETE FROM tables WHERE id=?').run(req.params.id)
  res.sendStatus(204)
})

// ── Table import (UVTT/zip creates a new table with floor 1) ─────────────────
tablesRouter.post('/tables/import', authMiddleware, adminOnly, upload.single('file'), (req, res) => {
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
  }

  const tableName = req.body.name || path.basename(decodeUploadFilename(req.file.originalname), ext)
  const meta = JSON.stringify(uvttJson)

  const insertAll = db.transaction(() => {
    db.prepare('INSERT INTO tables (id, name) VALUES (?,?)').run(tableId, tableName)
    db.prepare(
      `INSERT INTO floors (id, table_id, level, name, map_image_path, grid_size, uvt_metadata, img_width, img_height)
       VALUES (?,?,1,'',?,?,?,?,?)`
    ).run(floorId, tableId, imagePath, gridSize, meta, imgW, imgH)

    // Extract portals (doors/windows) onto floor 1
    if (Array.isArray(uvttJson.portals)) {
      const insertPortal = db.prepare('INSERT INTO portals (id, table_id, x1, y1, x2, y2, closed, floor_id) VALUES (?,?,?,?,?,?,?,?)')
      for (const portal of uvttJson.portals as Array<Record<string, unknown>>) {
        const bounds = portal.bounds as Array<{ x: number; y: number }> | undefined
        if (!bounds || bounds.length < 2) continue
        const p1 = bounds[0], p2 = bounds[bounds.length - 1]
        insertPortal.run(
          newId(), tableId,
          p1.x * gridSize, p1.y * gridSize,
          p2.x * gridSize, p2.y * gridSize,
          portal.closed !== false ? 1 : 0,   // default closed unless explicitly open
          floorId,
        )
      }
    }
  })
  insertAll()

  res.status(201).json({ ...getTable(tableId), floors: floorsOf(tableId) })
})

// ── Floors ────────────────────────────────────────────────────────────────────
/** Create an empty floor at the next level. */
tablesRouter.post('/tables/:id/floors', authMiddleware, adminOnly, (req, res) => {
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
tablesRouter.post('/tables/:id/floors/import', authMiddleware, adminOnly, upload.single('file'), (req, res) => {
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
  }

  const meta = JSON.stringify(uvttJson)
  db.transaction(() => {
    db.prepare(
      `INSERT INTO floors (id, table_id, level, name, map_image_path, grid_size, uvt_metadata, img_width, img_height)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(floorId, req.params.id, level, name, imagePath, gridSize, meta, imgW, imgH)

    if (Array.isArray(uvttJson.portals)) {
      const insertPortal = db.prepare('INSERT INTO portals (id, table_id, x1, y1, x2, y2, closed, floor_id) VALUES (?,?,?,?,?,?,?,?)')
      for (const portal of uvttJson.portals as Array<Record<string, unknown>>) {
        const bounds = portal.bounds as Array<{ x: number; y: number }> | undefined
        if (!bounds || bounds.length < 2) continue
        const p1 = bounds[0], p2 = bounds[bounds.length - 1]
        insertPortal.run(
          newId(), req.params.id,
          p1.x * gridSize, p1.y * gridSize,
          p2.x * gridSize, p2.y * gridSize,
          portal.closed !== false ? 1 : 0,
          floorId,
        )
      }
    }
  })()

  res.status(201).json(getFloor(floorId))
})

/** Upload/replace the map image of a floor. Client sends width/height for the dimension check. */
tablesRouter.post('/floors/:id/upload-image', authMiddleware, adminOnly, upload.single('image'), (req, res) => {
  const floor = getFloor(req.params.id)
  if (!floor) { res.status(404).json({ error: 'floor not found' }); return }
  if (!req.file) { res.status(400).json({ error: 'no file' }); return }
  const w = parseInt(String(req.body.width ?? '0')) || 0
  const h = parseInt(String(req.body.height ?? '0')) || 0
  const dimError = checkDimensions(floor.table_id, w, h)
  if (dimError) { res.status(409).json({ error: dimError }); return }
  const ext = path.extname(decodeUploadFilename(req.file.originalname)).toLowerCase() || '.png'
  const dir = uploadsDir()
  fs.mkdirSync(dir, { recursive: true })
  const filename = `map_${floor.id}${ext}`
  fs.writeFileSync(path.join(dir, filename), req.file.buffer)
  const imagePath = `/uploads/${filename}`
  db.prepare('UPDATE floors SET map_image_path=?, img_width=?, img_height=? WHERE id=?')
    .run(imagePath, w, h, floor.id)
  res.json({ path: imagePath, width: w, height: h })
})

tablesRouter.put('/floors/:id', authMiddleware, adminOnly, (req, res) => {
  const floor = getFloor(req.params.id)
  if (!floor) { res.status(404).json({ error: 'not found' }); return }
  const b = req.body
  const merged = {
    name:           b.name           !== undefined ? String(b.name)          : floor.name,
    grid_size:      b.grid_size      !== undefined ? b.grid_size             : floor.grid_size,
    map_offset_x:   b.map_offset_x   !== undefined ? b.map_offset_x          : floor.map_offset_x,
    map_offset_y:   b.map_offset_y   !== undefined ? b.map_offset_y          : floor.map_offset_y,
  }
  db.prepare('UPDATE floors SET name=?, grid_size=?, map_offset_x=?, map_offset_y=? WHERE id=?')
    .run(merged.name, merged.grid_size, merged.map_offset_x, merged.map_offset_y, floor.id)
  res.json(getFloor(floor.id))
})

tablesRouter.delete('/floors/:id', authMiddleware, adminOnly, (req, res) => {
  const floor = getFloor(req.params.id)
  if (!floor) { res.status(404).json({ error: 'not found' }); return }
  const count = db.prepare('SELECT COUNT(*) AS n FROM floors WHERE table_id=?').get(floor.table_id) as { n: number }
  if (count.n <= 1) { res.status(409).json({ error: 'cannot delete the last floor' }); return }
  db.transaction(() => {
    db.prepare('DELETE FROM tokens WHERE floor_id=?').run(floor.id)
    db.prepare('DELETE FROM portals WHERE floor_id=?').run(floor.id)
    db.prepare('DELETE FROM fog_points WHERE floor_id=?').run(floor.id)
    db.prepare('DELETE FROM stairs WHERE from_floor=? OR to_floor=?').run(floor.id, floor.id)
    db.prepare('DELETE FROM floors WHERE id=?').run(floor.id)
  })()
  res.sendStatus(204)
})

// ── Stairs ────────────────────────────────────────────────────────────────────
tablesRouter.post('/tables/:id/stairs', authMiddleware, adminOnly, (req, res) => {
  const { from_floor, from_x, from_y, to_floor, to_x, to_y, radius = 1 } = req.body
  const floors = floorsOf(req.params.id)
  const from = floors.find(f => f.id === from_floor)
  const to = floors.find(f => f.id === to_floor)
  if (!from || !to || from.id === to.id) { res.status(400).json({ error: 'stairs must link two different floors of this table' }); return }
  const id = newId()
  db.prepare('INSERT INTO stairs (id, table_id, from_floor, from_x, from_y, to_floor, to_x, to_y, radius) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, req.params.id, from_floor, from_x, from_y, to_floor, to_x, to_y, radius)
  res.status(201).json({ id, table_id: req.params.id, from_floor, from_x, from_y, to_floor, to_x, to_y, radius })
})

tablesRouter.delete('/stairs/:id', authMiddleware, adminOnly, (req, res) => {
  db.prepare('DELETE FROM stairs WHERE id=?').run(req.params.id)
  res.sendStatus(204)
})
