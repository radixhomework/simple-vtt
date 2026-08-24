/**
 * Shared asset library: token images and music tracks, deduplicated by
 * content hash so the same file is stored (and uploaded) only once no
 * matter how many tokens or tables reference it. Files live under
 * UPLOADS_DIR and are served through /uploads.
 */
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { db } from '../db'
import { authMiddleware, adminOnly } from '../auth'
import { musicLibraryChanged } from '../hub'
import { decodeUploadFilename } from '../filename'
import { loadSettings } from '../settings'

export const assetsRouter = Router()

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|svg)$/i
const AUDIO_EXT = /\.(mp3|ogg|oga|wav|m4a|aac|flac|webm|opus)$/i

/**
 * Asset upload parser with a per-request size limit taken from the admin
 * setting. Oversized files fail with a clear 413 instead of multer's
 * default 500.
 */
function assetUpload(req: Request, res: Response, next: NextFunction) {
  const maxMb = loadSettings().max_asset_size_mb
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxMb * 1024 * 1024 },
  }).single('file')(req, res, (err?: unknown) => {
    if (!err) { next(); return }
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: `file exceeds the ${maxMb} MB asset size limit` })
      return
    }
    res.status(400).json({ error: err instanceof Error ? err.message : 'upload failed' })
  })
}

function newId() { return crypto.randomUUID().replace(/-/g, '').slice(0, 16) }
const uploadsDir = () => process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')

assetsRouter.get('/assets', authMiddleware, (req, res) => {
  const kind = req.query.kind
  if (kind !== 'image' && kind !== 'audio') { res.status(400).json({ error: 'kind must be image or audio' }); return }
  res.json(db.prepare('SELECT id, kind, name, path, size, folder FROM assets WHERE kind=? ORDER BY folder, rowid').all(kind))
})

assetsRouter.post('/assets', authMiddleware, adminOnly, assetUpload, (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'no file' }); return }
  const kind = req.body.kind
  if (kind !== 'image' && kind !== 'audio') { res.status(400).json({ error: 'kind must be image or audio' }); return }
  const original = decodeUploadFilename(req.file.originalname)
  const ext = path.extname(original).toLowerCase()
  const extOk = kind === 'image' ? IMAGE_EXT.test(ext) : AUDIO_EXT.test(ext)
  if (!extOk) { res.status(400).json({ error: `unsupported ${kind} type` }); return }
  const folder = String(req.body.folder ?? '').slice(0, 100)

  // Deduplicate on content: the same file is stored once, whatever its name
  const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex')
  const existing = db.prepare('SELECT id, kind, name, path, size, folder FROM assets WHERE kind=? AND hash=?')
    .get(kind, hash) as { id: string; kind: string; name: string; path: string; size: number; folder: string } | undefined
  if (existing) {
    res.status(200).json({ ...existing, existing: true })
    return
  }

  const id = newId()
  const filename = `asset_${id}${ext}`
  fs.mkdirSync(uploadsDir(), { recursive: true })
  fs.writeFileSync(path.join(uploadsDir(), filename), req.file.buffer)
  const name = path.basename(original, ext)
  const url = `/uploads/${filename}`
  db.prepare('INSERT INTO assets (id, kind, name, hash, path, size, folder) VALUES (?,?,?,?,?,?,?)')
    .run(id, kind, name, hash, url, req.file.size, folder)

  // A new audio asset joins every table's music queue
  if (kind === 'audio') musicLibraryChanged()

  res.status(201).json({ id, kind, name, path: url, size: req.file.size, folder })
})

/** Move an asset to another folder (empty string = root). */
assetsRouter.put('/assets/:id', authMiddleware, adminOnly, (req, res) => {
  const row = db.prepare('SELECT id, kind FROM assets WHERE id=?').get(req.params.id) as
    { id: string; kind: string } | undefined
  if (!row) { res.status(404).json({ error: 'not found' }); return }

  const body = req.body as { folder?: unknown; name?: unknown }
  const sets: string[] = []
  const values: Array<string> = []

  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 200)
    if (!name) { res.status(400).json({ error: 'name required' }); return }
    sets.push('name=?')
    values.push(name)
  }
  if (body.folder !== undefined) {
    sets.push('folder=?')
    values.push(String(body.folder).slice(0, 100))
  }
  if (sets.length === 0) { res.status(400).json({ error: 'nothing to update' }); return }

  values.push(req.params.id)
  db.prepare(`UPDATE assets SET ${sets.join(', ')} WHERE id=?`).run(...values)

  // Renamed audio: push a fresh music state so every open music panel
  // shows the new track name (queues are id-based, nothing else changes)
  if (body.name !== undefined && row.kind === 'audio') musicLibraryChanged()

  const fresh = db.prepare('SELECT id, kind, name, path, size, folder FROM assets WHERE id=?')
    .get(req.params.id)
  res.json(fresh)
})

assetsRouter.delete('/assets/:id', authMiddleware, adminOnly, (req, res) => {
  const row = db.prepare('SELECT id, kind, path FROM assets WHERE id=?').get(req.params.id) as
    { id: string; kind: string; path: string } | undefined
  if (!row) { res.status(404).json({ error: 'not found' }); return }

  // Images still referenced by a token cannot be removed
  if (row.kind === 'image') {
    const inUse = db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE icon_path=?').get(row.path) as { n: number }
    if (inUse.n > 0) { res.status(409).json({ error: 'image is used by a token' }); return }
  }

  db.prepare('DELETE FROM assets WHERE id=?').run(req.params.id)
  // best-effort file removal
  fs.unlink(path.join(uploadsDir(), path.basename(row.path)), () => {})

  // Audio: rebuild every table's music queue (stops playback if current)
  if (row.kind === 'audio') musicLibraryChanged()

  res.sendStatus(204)
})
