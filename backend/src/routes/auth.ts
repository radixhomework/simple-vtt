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

  // Admin env override
  if (username === ADMIN_USER) {
    if (password !== ADMIN_PASS) { res.status(401).json({ error: 'invalid credentials' }); return }
    const token = signToken({ username: ADMIN_USER, role: 'admin' })
    res.json({ token, user: { username: ADMIN_USER, role: 'admin' } })
    return
  }

  const row = db.prepare('SELECT username, password_hash, role FROM users WHERE username=?').get(username) as
    { username: string; password_hash: string; role: string } | undefined

  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    res.status(401).json({ error: 'invalid credentials' }); return
  }

  const token = signToken({ username: row.username, role: row.role })
  res.json({ token, user: { username: row.username, role: row.role } })
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

authRouter.delete('/users/:username', authMiddleware, adminOnly, (req, res) => {
  db.prepare('DELETE FROM users WHERE username=?').run(req.params.username)
  res.sendStatus(204)
})
