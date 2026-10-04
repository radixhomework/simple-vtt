/**
 * Pending-restore application. The setup restore endpoint stages a backup,
 * validates it fully, then records a marker file and exits; this module —
 * imported in index.ts BEFORE ./app (which opens the database) — applies
 * the swap: staged database in place of the current one, staged uploads
 * tree in place of the current one (local driver). The application is
 * idempotent: a leftover marker re-runs the swap; a consumed marker is
 * removed. Retired files are recorded so the boot can clean them up once
 * the app is demonstrably healthy.
 */
import fs from 'node:fs'
import path from 'node:path'

const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'vtt.db')
const markerPath = `${dbPath}.restore.json`
const stagingDir = path.join(path.dirname(dbPath), 'vtt.db.restore-staging')

/** Paths left behind by the swap (old database / old uploads tree), for
 *  post-boot cleanup once the server is listening. */
let retiredPaths: string[] = []
export function retiredRestorePaths(): string[] {
  return retiredPaths
}

/** Retire the current database (plus its WAL/SHM leftovers) and move the
 *  staged one in — WAL files of the old database must not bleed into the
 *  new one. */
function swapDatabase(stagedDb: string, stamp: string): void {
  if (!fs.existsSync(stagedDb)) return
  if (fs.existsSync(dbPath)) {
    const retiredDb = `${dbPath}.retired-${stamp}`
    fs.renameSync(dbPath, retiredDb)
    retiredPaths.push(retiredDb)
  }
  for (const suffix of ['-wal', '-shm']) {
    const f = dbPath + suffix
    if (fs.existsSync(f)) {
      const retired = f + `.retired-${stamp}`
      fs.renameSync(f, retired)
      retiredPaths.push(retired)
    }
  }
  fs.renameSync(stagedDb, dbPath)
}

/** Retire the current uploads tree and move the staged one in. */
function swapUploads(stagedUploads: string, stamp: string): void {
  if (!fs.existsSync(stagedUploads)) return
  const uploadsDir = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')
  if (fs.existsSync(uploadsDir)) {
    const retiredUploads = `${uploadsDir}.retired-${stamp}`
    fs.renameSync(uploadsDir, retiredUploads)
    retiredPaths.push(retiredUploads)
  }
  fs.renameSync(stagedUploads, uploadsDir)
}

export function applyPendingRestore(): void {
  if (!fs.existsSync(markerPath)) return
  let plan: { db?: string; uploads?: string }
  try {
    plan = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { db?: string; uploads?: string }
  } catch (e) {
    console.error('[restore] unreadable restore marker — leaving state untouched:', e)
    return
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  try {
    swapDatabase(plan.db ?? '', stamp)
    swapUploads(plan.uploads ?? '', stamp)
    fs.unlinkSync(markerPath)
    // Whatever is left in staging (the original zip, an empty extracted
    // dir) is consumed state — remove it
    fs.rmSync(stagingDir, { recursive: true, force: true })
    console.log('[restore] pending restore applied — instance is now the restored state')
  } catch (e) {
    // The marker survives: the next boot re-runs the swap (idempotent for
    // the parts already applied — renames of renames just retire again)
    console.error('[restore] failed to apply pending restore — marker kept for retry:', e)
  }
}

/** Delete the previous instance's files once the app is up (called from
 *  the listen callback). Failures are non-fatal: a stray retired dir can
 *  be removed by hand. */
export function cleanupRetiredRestore(): void {
  for (const p of retiredPaths) {
    try { fs.rmSync(p, { recursive: true, force: true }) } catch { /* keep */ }
  }
  retiredPaths = []
}
