/**
 * Post-migration cleanup: reclaim the local disk space that the S3
 * migration deliberately left behind. Every blob under the local uploads
 * tree is first verified against the bucket — ALL of them, before a single
 * deletion — and only then are the local copies removed. Dry-run by
 * default; `--delete` performs the cleanup. The database and the rest of
 * the data volume are never touched.
 *
 * Run: docker compose exec app node dist/prune-local-uploads.js [--delete]
 * Unlike migrate-to-s3.js this reads STORAGE_DRIVER without forcing it:
 * pruning only makes sense once the running app actually serves from S3.
 */
import fs from 'node:fs'
import path from 'node:path'
import { storage } from './storage'

const uploadsDir = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')
const DELETE = process.argv.includes('--delete')
const MAX_REPORTED_MISSING = 20

interface LocalFile {
  key: string
  path: string
  /** -1 marks a staging directory (removed wholesale, no size needed). */
  size: number
}

/** Dirs owned by the first-start restore feature: reported, never touched. */
function isRestoreRetired(name: string): boolean {
  return /^uploads(\.retired|\.staging)/.test(name) || name.startsWith('vtt.db.')
}

function humanSize(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let v = bytes
  let u = 0
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++ }
  return `${v.toFixed(v >= 10 || u === 0 ? 0 : 1)} ${units[u]}`
}

function collectFiles(): { files: LocalFile[]; skippedRetired: string[] } {
  const files: LocalFile[] = []
  const skippedRetired: string[] = []
  const walk = (dir: string, prefix: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = String(e.name)
      const full = path.join(dir, name)
      const key = prefix ? `${prefix}/${name}` : name
      if (e.isDirectory()) {
        if (name.startsWith('.tmp-')) {
          // Tile-pyramid staging leftovers: dead weight either way
          files.push({ key, path: full, size: -1 })
          continue
        }
        walk(full, key)
        continue
      }
      if (isRestoreRetired(name)) { skippedRetired.push(key); continue }
      files.push({ key, path: full, size: fs.statSync(full).size })
    }
  }
  walk(uploadsDir, '')
  return { files, skippedRetired }
}

/** Verify every key against the bucket; returns the missing ones. */
async function verifyAll(files: LocalFile[]): Promise<string[]> {
  const missing: string[] = []
  for (const f of files) {
    // Sequential on purpose: gentle on the endpoint, same as the migration
    const ok = await storage().exists(f.key).catch(() => false) // NOSONAR: ordered, intentional
    if (!ok) missing.push(f.key)
  }
  return missing
}

/** Report the first missing keys and exit. */
function abortWithMissing(missing: string[]): never {
  console.error(`\nverification FAILED — ${missing.length} file(s) missing from the bucket, deleting nothing. First missing keys:`)
  for (const k of missing.slice(0, MAX_REPORTED_MISSING)) console.error(`  ${k}`)
  if (missing.length > MAX_REPORTED_MISSING) console.error(`  … and ${missing.length - MAX_REPORTED_MISSING} more`)
  process.exit(1)
}

/** Delete verified files, then prune emptied directories bottom-up. */
function deleteVerified(files: LocalFile[]): { deleted: number; failed: number } {
  let deleted = 0
  let failed = 0
  const dirs: string[] = []
  const walkDelete = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = String(e.name)
      const full = path.join(dir, name)
      if (e.isDirectory()) { dirs.push(full); walkDelete(full); continue }
      if (isRestoreRetired(name)) continue
      try { fs.rmSync(full); deleted++ } catch { failed++ }
    }
  }
  walkDelete(uploadsDir)
  // Deepest first so parents empty out
  dirs.sort((a, b) => b.length - a.length)
  for (const d of dirs) {
    try { fs.rmdirSync(d) } catch { /* non-empty or gone — fine */ }
  }
  return { deleted, failed }
}

async function main(): Promise<void> {
  if ((process.env.STORAGE_DRIVER || '') !== 's3') {
    console.error(
      'refusing to prune: the local uploads tree is the live data store unless\n' +
      'STORAGE_DRIVER=s3. Migrate and switch first (see docs/BACKUP-RESTORE.md).',
    )
    process.exit(1)
  }
  if (!fs.existsSync(uploadsDir)) {
    console.log(`nothing to prune: local uploads dir not found (${uploadsDir})`)
    return
  }

  const { files, skippedRetired } = collectFiles()
  const deletable = files.filter(f => f.size >= 0)
  const stagingCount = files.length - deletable.length
  const totalBytes = deletable.reduce((sum, f) => sum + f.size, 0)
  const stagingNote = stagingCount > 0 ? ` (+${stagingCount} staging dirs)` : ''
  console.log(`local uploads tree: ${deletable.length} files, ${humanSize(totalBytes)}${stagingNote}`)
  for (const s of skippedRetired) console.log(`keeping (restore-retired): ${s}`)

  // Verify everything BEFORE deleting anything — never interleaved
  const missing = await verifyAll(deletable)
  if (missing.length > 0) abortWithMissing(missing)
  console.log(`verification passed: all ${deletable.length} blobs exist in the bucket`)

  if (!DELETE) {
    console.log('\ndry run — nothing was deleted.')
    console.log('re-run with --delete to remove these local copies.')
    return
  }

  const { deleted, failed } = deleteVerified(deletable)
  const failedNote = failed > 0 ? `, ${failed} FAILED (left in place)` : ''
  console.log(`\ndone: ${deleted} local copies removed${failedNote}.`)
  console.log('the application keeps serving everything from the bucket.')
  if (failed > 0) process.exit(1)
}

void main()
