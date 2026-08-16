import jwt from 'jsonwebtoken'
import { Request, Response, NextFunction } from 'express'

const SECRET = process.env.JWT_SECRET || 'rhwvtt-dev-secret-change-in-production'

export interface JWTPayload {
  username: string
  role: string
}

export function signToken(payload: JWTPayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: '24h' })
}

export function verifyToken(token: string): JWTPayload | null {
  try {
    return jwt.verify(token, SECRET) as JWTPayload
  } catch {
    return null
  }
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) return header.slice(7)
  if (req.query.token) return req.query.token as string
  return null
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const token = extractToken(req)
  if (!token) { res.status(401).json({ error: 'unauthorized' }); return }
  const payload = verifyToken(token)
  if (!payload) { res.status(401).json({ error: 'invalid token' }); return }
  res.locals.user = payload.username
  res.locals.role = payload.role
  next()
}

export function adminOnly(_req: Request, res: Response, next: NextFunction) {
  if (res.locals.role !== 'admin') { res.status(403).json({ error: 'forbidden' }); return }
  next()
}
