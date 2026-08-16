import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import AdmZip from 'adm-zip'
import { db } from '../db'
import { authMiddleware, adminOnly } from '../auth'

export const tablesRouter = Router()

const uploadsDir = () => process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')

const storage = multer.memoryStorage()
const upload = multer({ storage, limits: { fileSize: 150 * 1024 * 1024 } })

function newId() { return crypto.randomUUID().replace(/-/g, '').slice(0, 16) }

function getTable(id: string) {
  return db.prepare('SELECT id, name, map_image_path, grid_size, uvt_metadata, map_offset_x, map_offset_y FROM tables WHERE id=?').get(id) as
    { id: string; name: string; map_image_path: string; grid_size: number; uvt_metadata: string; map_offset_x: number; map_offset_y: number } | undefined
}

tablesRouter.get('/tables', authMiddleware, (_req, res) => {
  const rows = db.prepare('SELECT id, name, map_image_path, grid_size, uvt_metadata, map_offset_x, map_offset_y FROM tables').all()
  res.json(rows)
})

tablesRouter.post('/tables', authMiddleware, adminOnly, (req, res) => {
  const { name, grid_size = 70, map_image_path = '', uvt_metadata = '{}', map_offset_x = 0, map_offset_y = 0 } = req.body
  if (!name) { res.status(400).json({ error: 'name required' }); return }
  const id = newId()
  db.prepare('INSERT INTO tables (id, name, map_image_path, grid_size, uvt_metadata, map_offset_x, map_offset_y) VALUES (?,?,?,?,?,?,?)').run(id, name, map_image_path, grid_size, uvt_metadata, map_offset_x, map_offset_y)
  res.status(201).json(getTable(id))
})

tablesRouter.get('/tables/:id', authMiddleware, (req, res) => {
  const t = getTable(req.params.id)
  if (!t) { res.status(404).json({ error: 'not found' }); return }
  res.json(t)
})

tablesRouter.put('/tables/:id', authMiddleware, adminOnly, (req, res) => {
  const { name, map_image_path, grid_size, uvt_metadata, map_offset_x, map_offset_y } = req.body
  db.prepare('UPDATE tables SET name=?, map_image_path=?, grid_size=?, uvt_metadata=?, map_offset_x=?, map_offset_y=? WHERE id=?').run(name, map_image_path, grid_size, uvt_metadata, map_offset_x, map_offset_y, req.params.id)
  res.json(getTable(req.params.id))
})

tablesRouter.delete('/tables/:id', authMiddleware, adminOnly, (req, res) => {
  db.prepare('DELETE FROM tables WHERE id=?').run(req.params.id)
  res.sendStatus(204)
})

// ── Import UVTT ────────────────────────────────────────────────────────────────
tablesRouter.post('/tables/import', authMiddleware, adminOnly, upload.single('file'), (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'no file' }); return }

  const ext = path.extname(req.file.originalname).toLowerCase()
  let uvttJson: Record<string, unknown>
  let imageBuffer: Buffer | null = null
  let imageExt = '.png'

  try {
    if (ext === '.zip') {
      const zip = new AdmZip(req.file.buffer)
      let uvttEntry = zip.getEntries().find(e => /\.(uvtt|dd2vtt)$/i.test(e.name))
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

  // Extract grid size
  const resolution = uvttJson.resolution as Record<string, unknown> | undefined
  const gridSize = typeof resolution?.pixels_per_grid === 'number' ? Math.round(resolution.pixels_per_grid) : 70

  // Extract image from base64 if not from zip
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

  const tableId = newId()
  let imagePath = ''

  if (imageBuffer) {
    const dir = uploadsDir()
    fs.mkdirSync(dir, { recursive: true })
    const filename = `map_${tableId}${imageExt}`
    fs.writeFileSync(path.join(dir, filename), imageBuffer)
    imagePath = `/uploads/${filename}`
  }

  const tableName = req.body.name || path.basename(req.file.originalname, ext)
  const meta = JSON.stringify(uvttJson)

  const insertAll = db.transaction(() => {
    db.prepare('INSERT INTO tables (id, name, map_image_path, grid_size, uvt_metadata, map_offset_x, map_offset_y) VALUES (?,?,?,?,?,0,0)').run(tableId, tableName, imagePath, gridSize, meta)

    // Extract portals (doors/windows) from UVTT
    if (Array.isArray(uvttJson.portals)) {
      const insertPortal = db.prepare('INSERT INTO portals (id, table_id, x1, y1, x2, y2, closed) VALUES (?,?,?,?,?,?,?)')
      for (const portal of uvttJson.portals as Array<Record<string, unknown>>) {
        const bounds = portal.bounds as Array<{ x: number; y: number }> | undefined
        if (!bounds || bounds.length < 2) continue
        const p1 = bounds[0], p2 = bounds[bounds.length - 1]
        insertPortal.run(
          newId(), tableId,
          p1.x * gridSize, p1.y * gridSize,
          p2.x * gridSize, p2.y * gridSize,
          portal.closed !== false ? 1 : 0   // default closed unless explicitly open
        )
      }
    }
  })
  insertAll()

  res.status(201).json(getTable(tableId))
})

// ── Upload image for existing table ───────────────────────────────────────────
tablesRouter.post('/tables/:id/upload-image', authMiddleware, adminOnly, upload.single('image'), (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'no file' }); return }
  const ext = path.extname(req.file.originalname).toLowerCase() || '.png'
  const dir = uploadsDir()
  fs.mkdirSync(dir, { recursive: true })
  const filename = `map_${req.params.id}${ext}`
  fs.writeFileSync(path.join(dir, filename), req.file.buffer)
  const imagePath = `/uploads/${filename}`
  db.prepare('UPDATE tables SET map_image_path=? WHERE id=?').run(imagePath, req.params.id)
  res.json({ path: imagePath })
})

// ── Upload token icon ─────────────────────────────────────────────────────────
tablesRouter.post('/upload-token-icon', authMiddleware, adminOnly, upload.single('icon'), (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'no file' }); return }
  const ext = path.extname(req.file.originalname).toLowerCase() || '.png'
  const dir = uploadsDir()
  fs.mkdirSync(dir, { recursive: true })
  const filename = `token_${newId()}${ext}`
  fs.writeFileSync(path.join(dir, filename), req.file.buffer)
  res.json({ path: `/uploads/${filename}` })
})
