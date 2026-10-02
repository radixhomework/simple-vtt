/**
 * Whole-instance backup: GET /api/backup/export streams a ZIP holding a
 * consistent snapshot of the SQLite database plus — with the `local`
 * storage driver — every blob under the uploads tree at its storage key.
 * With the `s3` driver the archive is database-only: the DB's upload
 * references resolve against the bucket, which is backed up externally.
 */
import { Router } from 'express'
import fs from 'fs'
import path from 'path'
import archiver from 'archiver'
import { db } from '../db'
import { authMiddleware, adminOnly } from '../auth'
import { storage } from '../storage'

export const backupRouter = Router()

const uploadsDir = () => process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')

/** Staging/marker files produced by a pending or past restore — never
 *  part of a backup. */
function isRestoreArtifact(name: string): boolean {
  return /^vtt\.db\.(restore|retired|staging)/.test(name)
    || /^uploads(\.retired|\.staging|$)/.test(name)
    || name.includes('.tmp-')
}

/** Consistent snapshot of the running WAL database into a standalone
 *  file (better-sqlite3 pages the WAL in while writes keep flowing). */
function snapshotDatabase(dest: string) {
  return db.backup(dest)
}

backupRouter.get('/backup/export', authMiddleware, adminOnly, async (req, res) => {
  const driver = process.env.STORAGE_DRIVER || 'local'
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)

  const tmpDir = path.join(path.dirname(uploadsDir()), `backup-staging-${stamp}`)
  const dbSnapshot = path.join(tmpDir, 'vtt.db')
  await fs.promises.mkdir(tmpDir, { recursive: true })

  try {
    await snapshotDatabase(dbSnapshot)
  } catch (e) {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
    console.error('[backup] database snapshot failed:', e)
    res.status(500).json({ error: 'database snapshot failed' })
    return
  }

  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', `attachment; filename="simple-vtt-backup-${stamp}.zip"`)
  const archive = archiver('zip', { zlib: { level: 6 } })
  archive.on('warning', (err: Error) => console.warn('[backup] archiver warning:', err))
  archive.on('error', (err: Error) => {
    console.error('[backup] archiver error:', err)
    if (!res.headersSent) res.status(500)
    res.destroy()
  })
  archive.pipe(res)

  archive.file(dbSnapshot, { name: 'vtt.db' })
  archive.append(JSON.stringify({
    kind: 'simple-vtt-backup',
    version: (() => { try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version } catch { return '0.0.0' } })(),
    driver,
    created_at: new Date().toISOString(),
  }), { name: 'manifest.json' })

  if (driver === 'local') {
    const walk = (dir: string, prefix: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const name = String(e.name)
        const full = path.join(dir, name)
        const key = prefix ? `${prefix}/${name}` : name
        if (e.isDirectory()) {
          walk(full, key)
          continue
        }
        if (!isRestoreArtifact(name)) archive.file(full, { name: key })
      }
    }
    try {
      walk(uploadsDir(), '')
    } catch { /* no uploads tree yet — DB-only backup */ }
  }

  void archive.finalize()
  const done = new Promise(resolve => res.on('close', resolve))
  await done
  await fs.promises.rm(tmpDir, { recursive: true, force: true })
})
