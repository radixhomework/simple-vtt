/**
 * First-start setup. Served only while setup is not completed: the wizard
 * either creates the first admin account (or adopts the env bootstrap
 * admin) or imports a whole-instance backup. The `setup_completed` marker
 * lives in the settings table — inside the database — so it travels with
 * backups and a restored instance never re-opens the wizard. All setup
 * endpoints are unauthenticated by nature and therefore rate-limited like
 * login, and hard-closed once the marker exists.
 */
import { Router, Request, Response } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import Database from 'better-sqlite3'
import unzipper from 'unzipper'
import { db } from '../db'
import { loginLimiter } from '../ratelimit'
import { signToken } from '../auth'
import { ADMIN_USER, ADMIN_PASS } from './auth'

export const setupRouter = Router()

const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'vtt.db')
const dataDir = path.dirname(dbPath)
const stagingDir = path.join(dataDir, 'vtt.db.restore-staging')
const extractDir = path.join(stagingDir, 'extracted')

/** Upload / total-uncompressed caps (env-overridable, 2 GiB / 4 GiB). */
const MAX_UPLOAD_BYTES = Number(process.env.RESTORE_MAX_BYTES || 2 * 1024 ** 3)
const MAX_UNCOMPRESSED_BYTES = MAX_UPLOAD_BYTES * 2

function setupCompleted(): boolean {
  return !!db.prepare("SELECT value FROM settings WHERE key='setup_completed'").get()
}

function markSetupCompleted(): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('setup_completed', ?)")
    .run(new Date().toISOString())
}

setupRouter.get('/setup/status', (_req, res) => {
  res.json({ completed: setupCompleted() })
})

setupRouter.post('/setup/admin', loginLimiter, (req: Request, res: Response) => {
  if (setupCompleted()) { res.status(403).json({ error: 'setup already completed' }); return }
  const { username, password } = req.body as { username?: string; password?: string }
  if (!username || !password) { res.status(400).json({ error: 'missing fields' }); return }
  if (typeof username !== 'string' || username.length > 40 || typeof password !== 'string' || password.length < 4) {
    res.status(400).json({ error: 'invalid username or password (min 4 chars)' }); return
  }

  const existing = db.prepare('SELECT username, password_hash FROM users WHERE username=?').get(username) as
    { username: string; password_hash: string } | undefined
  if (existing) {
    // Adopt: an account already exists under that name (env bootstrap or a
    // previous partial run) — verifying the password takes it over.
    const ok = bcrypt.compareSync(password, existing.password_hash)
      || (username === ADMIN_USER && password === ADMIN_PASS)
    if (!ok) { res.status(401).json({ error: 'invalid credentials' }); return }
  } else {
    const hash = bcrypt.hashSync(password, 10)
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)').run(username, hash, 'admin')
  }
  markSetupCompleted()
  res.json({ token: signToken({ username, role: 'admin' }), user: { username, role: 'admin' } })
})

/** Stream the uploaded backup to the staging area with a hard size cap. */
function stageUpload(req: Request): Promise<{ ok: true; zipPath: string } | { ok: false; status: number; error: string }> {
  return new Promise(resolve => {
    const declared = Number(req.headers['content-length'] ?? '0')
    if (!Number.isFinite(declared) || declared <= 0 || declared > MAX_UPLOAD_BYTES) {
      resolve({ ok: false, status: 413, error: 'backup size out of bounds' })
      req.destroy()
      return
    }
    fs.mkdirSync(stagingDir, { recursive: true })
    const zipPath = path.join(stagingDir, 'backup.zip')
    const out = fs.createWriteStream(zipPath)
    let total = 0
    let aborted = false
    req.on('data', (c: Buffer) => {
      total += c.length
      if (total > MAX_UPLOAD_BYTES) {
        aborted = true
        req.destroy()
        out.destroy()
        resolve({ ok: false, status: 413, error: 'backup size out of bounds' })
      }
    })
    req.on('error', () => { if (!aborted) { aborted = true; resolve({ ok: false, status: 400, error: 'upload failed' }) } })
    req.pipe(out)
    out.on('finish', () => { if (!aborted) resolve({ ok: true, zipPath }) })
    out.on('error', () => { if (!aborted) { aborted = true; resolve({ ok: false, status: 500, error: 'staging write failed' }) } })
  })
}

const REQUIRED_TABLES = ['users', 'tables', 'floors', 'settings']

type ZipEntry = unzipper.Entry & { path: string; type: string; size?: number }

/** Consume one zip entry fully, writing it to `dest` with backpressure and
 *  a per-entry uncompressed-size cap. */
async function stageEntry(dest: string, e: ZipEntry): Promise<number> {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true })
  const out = fs.createWriteStream(dest)
  let written = 0
  for await (const c of e) {
    written += (c as Buffer).length
    if (written > MAX_UNCOMPRESSED_BYTES) throw new Error(`entry too large: ${e.path}`)
    if (!out.write(c as Buffer)) await new Promise<void>(r => out.once('drain', () => r()))
  }
  out.end()
  return written
}

/** Read + parse the manifest entry; also asserts it is our backup kind. */
async function readManifest(e: ZipEntry): Promise<{ driver: string | null }> {
  const chunks: Buffer[] = []
  for await (const c of e) chunks.push(c as Buffer)
  try {
    const m = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { kind?: string; driver?: string }
    if (m.kind !== 'simple-vtt-backup') throw new Error('not a simple-vtt backup')
    return { driver: m.driver ?? null }
  } catch {
    throw new Error('invalid manifest.json')
  }
}

/** The staged database must open and carry the core tables before it can
 *  replace anything. Setup is marked completed inside it — the flag
 *  travels with the restored state. */
function validateStagedDb(stagedDb: string): void {
  const staged = new Database(stagedDb)
  try {
    const names = (staged.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map(r => r.name)
    const present = new Set(names)
    for (const t of REQUIRED_TABLES) {
      if (!present.has(t)) throw new Error(`restored database is missing table: ${t}`)
    }
    staged.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('setup_completed', ?)")
      .run(new Date().toISOString())
  } finally {
    staged.close()
  }
}

/** Extraction state shared across zip entries. */
interface Staging {
  stagedDb: string
  stagedUploads: string
  total: number
  sawDb: boolean
  sawManifest: boolean
  driver: string | null
}

/** Stage one zip entry: the database at its root path, the manifest into
 *  parsed state, blobs at their storage keys (only for local-driver
 *  backups — an s3 backup is DB-only by construction); anything else is
 *  drained. Returns nothing; mutates `st`. */
async function stageOneEntry(e: ZipEntry, name: string, st: Staging): Promise<void> {
  if (name === 'vtt.db') {
    st.sawDb = true
    st.total += await stageEntry(st.stagedDb, e)
    return
  }
  if (name === 'manifest.json') {
    const manifest = await readManifest(e)
    st.driver = manifest.driver
    st.sawManifest = true
    return
  }
  if (st.driver !== 'local' && st.driver !== null) {
    e.autodrain()
    return
  }
  st.total += e.size ?? 0
  await stageEntry(path.join(st.stagedUploads, name), e)
}

/** Extract + validate the staged archive. Returns the staged database and
 *  (when the backup carries blobs) staged uploads tree. Nothing existing is
 *  touched — everything lands under the staging dir; the caller writes the
 *  restore marker only after this succeeds. */
async function extractAndValidate(zipPath: string): Promise<{ stagedDb: string; stagedUploads: string | null }> {
  await fs.promises.rm(extractDir, { recursive: true, force: true })
  fs.mkdirSync(extractDir, { recursive: true })

  const st: Staging = {
    stagedDb: path.join(extractDir, 'vtt.db'),
    stagedUploads: path.join(extractDir, 'uploads'),
    total: 0,
    sawDb: false,
    sawManifest: false,
    driver: null,
  }

  const zip = fs.createReadStream(zipPath).pipe(unzipper.Parse({ forceStream: true }))
  for await (const entry of zip) {
    const e = entry as ZipEntry
    if (e.type !== 'File') { e.autodrain(); continue }
    const name = e.path.replace(/\\/g, '/')
    if (name.includes('..') || path.isAbsolute(name)) { e.autodrain(); continue }
    if (e.size !== undefined && e.size > MAX_UNCOMPRESSED_BYTES) throw new Error(`entry too large: ${name}`)
    await stageOneEntry(e, name, st)
    if (st.total > MAX_UNCOMPRESSED_BYTES) throw new Error('total uncompressed size out of bounds')
  }

  if (!st.sawDb || !st.sawManifest) throw new Error('archive is missing vtt.db or manifest.json')
  validateStagedDb(st.stagedDb)

  const hasBlobs = fs.existsSync(st.stagedUploads)
  return { stagedDb: st.stagedDb, stagedUploads: hasBlobs ? st.stagedUploads : null }
}

setupRouter.post('/setup/restore', loginLimiter, async (req: Request, res: Response) => {
  if (setupCompleted()) { res.status(403).json({ error: 'setup already completed' }); return }

  const staged = await stageUpload(req)
  if (!staged.ok) { res.status(staged.status).json({ error: staged.error }); return }

  try {
    const { stagedDb, stagedUploads } = await extractAndValidate(staged.zipPath)

    // Record the pending swap, then exit — the supervisor restarts the app,
    // and restore-apply.ts (running before the database opens) performs it.
    const markerPath = `${dbPath}.restore.json`
    const markerTmp = `${markerPath}.tmp`
    fs.writeFileSync(markerTmp, JSON.stringify({ db: stagedDb, uploads: stagedUploads }))
    fs.renameSync(markerTmp, markerPath)

    res.json({ ok: true, restarting: true })
    // Let the response flush before exiting
    setTimeout(() => process.exit(0), 200)
  } catch (e) {
    console.error('[setup] restore rejected:', e)
    await fs.promises.rm(stagingDir, { recursive: true, force: true })
    res.status(400).json({ error: e instanceof Error ? e.message : 'invalid backup' })
  }
})
