/**
 * Authentication & user management. The admin account is configured through
 * the environment (ADMIN_USERNAME/ADMIN_PASSWORD) and checked at login time;
 * all other accounts live in the database with bcrypt-hashed passwords.
 */
import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { db } from '../db'
import { signToken, authMiddleware, adminOnly } from '../auth'

export const authRouter = Router()

const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'admin'

function ensureAdmin() {
  const exists = db.prepare('SELECT username FROM users WHERE username=?').get(ADMIN_USER)
  if (!exists) {
    const hash = bcrypt.hashSync(ADMIN_PASS, 10)
    db.prepare('INSERT OR IGNORE INTO users (username, password_hash, role) VALUES (?,?,?)').run(ADMIN_USER, hash, 'admin')
  }
}
ensureAdmin()

authRouter.post('/auth/login', (req, res) => {
  const { username, password } = req.body as { username: string; password: string }
  if (!username || !password) { res.status(400).json({ error: 'missing fields' }); return }

  const row = db.prepare('SELECT username, password_hash, role FROM users WHERE username=?').get(username) as
    { username: string; password_hash: string; role: string } | undefined

  // DB hash is authoritative; the env password also works for the admin
  // account so it doubles as a recovery backdoor.
  const hashOk = row ? bcrypt.compareSync(password, row.password_hash) : false
  const envOk = username === ADMIN_USER && password === ADMIN_PASS
  if (!hashOk && !envOk) { res.status(401).json({ error: 'invalid credentials' }); return }

  const out = row ?? { username: ADMIN_USER, role: 'admin' }
  const token = signToken({ username: out.username, role: out.role })
  res.json({ token, user: { username: out.username, role: out.role } })
})

/** Change the caller's own password (admin and players). */
authRouter.post('/auth/password', authMiddleware, (req, res) => {
  const { current_password, new_password } = req.body as { current_password: string; new_password: string }
  if (!current_password || !new_password) { res.status(400).json({ error: 'missing fields' }); return }
  if (new_password.length < 4) { res.status(400).json({ error: 'new password too short (min 4)' }); return }

  const row = db.prepare('SELECT password_hash FROM users WHERE username=?').get(res.locals.user) as
    { password_hash: string } | undefined
  const hashOk = row ? bcrypt.compareSync(current_password, row.password_hash) : false
  const envOk = res.locals.user === ADMIN_USER && current_password === ADMIN_PASS
  if (!hashOk && !envOk) { res.status(401).json({ error: 'invalid credentials' }); return }

  db.prepare('UPDATE users SET password_hash=? WHERE username=?')
    .run(bcrypt.hashSync(new_password, 10), res.locals.user)
  res.json({ ok: true })
})

authRouter.get('/me', authMiddleware, (req, res) => {
  res.json({ username: res.locals.user, role: res.locals.role })
})

authRouter.get('/users', authMiddleware, adminOnly, (_req, res) => {
  const users = db.prepare('SELECT username, role FROM users').all()
  res.json(users)
})

authRouter.post('/users', authMiddleware, adminOnly, (req, res) => {
  const { username, password, role = 'player' } = req.body as { username: string; password: string; role?: string }
  if (!username || !password) { res.status(400).json({ error: 'missing fields' }); return }
  if (role !== 'admin' && role !== 'player') { res.status(400).json({ error: 'invalid role' }); return }
  if (username === ADMIN_USER) { res.status(400).json({ error: 'reserved username' }); return }
  const hash = bcrypt.hashSync(password, 10)
  db.prepare('INSERT OR REPLACE INTO users (username, password_hash, role) VALUES (?,?,?)').run(username, hash, role)
  res.status(201).json({ username, role })
})

authRouter.put('/users/:username', authMiddleware, adminOnly, (req, res) => {
  const { role } = req.body as { role: string }
  if (role !== 'admin' && role !== 'player') { res.status(400).json({ error: 'invalid role' }); return }
  if (req.params.username === res.locals.user) { res.status(400).json({ error: 'cannot change your own role' }); return }
  const r = db.prepare('UPDATE users SET role=? WHERE username=?').run(role, req.params.username)
  if (r.changes === 0) { res.status(404).json({ error: 'not found' }); return }
  res.json({ username: req.params.username, role })
})

/** Admin resets another user's password. */
authRouter.post('/users/:username/password', authMiddleware, adminOnly, (req, res) => {
  const { new_password } = req.body as { new_password: string }
  if (!new_password || new_password.length < 4) { res.status(400).json({ error: 'password too short (min 4)' }); return }
  const r = db.prepare('UPDATE users SET password_hash=? WHERE username=?')
    .run(bcrypt.hashSync(new_password, 10), req.params.username)
  if (r.changes === 0) { res.status(404).json({ error: 'not found' }); return }
  res.json({ ok: true })
})

authRouter.delete('/users/:username', authMiddleware, adminOnly, (req, res) => {
  if (req.params.username === res.locals.user) { res.status(400).json({ error: 'cannot delete yourself' }); return }
  db.prepare('DELETE FROM users WHERE username=?').run(req.params.username)
  res.sendStatus(204)
})
