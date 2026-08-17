/**
 * Music library: upload (admin, stored under UPLOADS_DIR), list, delete.
 * Playback itself is not streamed from here — clients fetch the files via
 * /uploads and stay in sync through the hub's music_state pushes.
 */
import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { db } from '../db'
import { authMiddleware, adminOnly } from '../auth'
import { musicLibraryChanged } from '../hub'

export const musicRouter = Router()

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } })
const AUDIO_EXT = /\.(mp3|ogg|oga|wav|m4a|aac|flac|webm|opus)$/i

function newId() { return crypto.randomUUID().replace(/-/g, '').slice(0, 16) }
const uploadsDir = () => process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')

musicRouter.get('/music', authMiddleware, (_req, res) => {
  res.json(db.prepare('SELECT id, name, path FROM music ORDER BY rowid').all())
})

musicRouter.post('/music', authMiddleware, adminOnly, upload.single('music'), (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'no file' }); return }
  const ext = path.extname(req.file.originalname).toLowerCase()
  if (!AUDIO_EXT.test(ext)) { res.status(400).json({ error: 'unsupported audio type' }); return }
  const id = newId()
  const filename = `music_${id}${ext}`
  fs.mkdirSync(uploadsDir(), { recursive: true })
  fs.writeFileSync(path.join(uploadsDir(), filename), req.file.buffer)
  const name = path.basename(req.file.originalname, ext)
  const url = `/uploads/${filename}`
  db.prepare('INSERT INTO music (id, name, path) VALUES (?,?,?)').run(id, name, url)
  musicLibraryChanged()
  res.status(201).json({ id, name, path: url })
})

musicRouter.delete('/music/:id', authMiddleware, adminOnly, (req, res) => {
  const row = db.prepare('SELECT id, path FROM music WHERE id=?').get(req.params.id) as { id: string; path: string } | undefined
  if (!row) { res.status(404).json({ error: 'not found' }); return }
  db.prepare('DELETE FROM music WHERE id=?').run(req.params.id)
  // best-effort file removal
  fs.unlink(path.join(uploadsDir(), path.basename(row.path)), () => {})
  musicLibraryChanged()
  res.sendStatus(204)
})
