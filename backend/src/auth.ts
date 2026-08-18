import jwt from 'jsonwebtoken'
import { Request, Response, NextFunction } from 'express'

/** Signing secret — override with JWT_SECRET in production. */
const SECRET = process.env.JWT_SECRET || 'simple-vtt-dev-secret-change-in-production'

/** Token lifetime: clients must re-login after this period. */
export const TOKEN_TTL = '12h'

export interface JWTPayload {
  username: string
  role: string
}

export function signToken(payload: JWTPayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: TOKEN_TTL })
}

export function verifyToken(token: string): JWTPayload | null {
  try {
    return jwt.verify(token, SECRET) as JWTPayload
  } catch {
    return null
  }
}

/** Accept the JWT from the Authorization header or a ?token= query param
 *  (browsers cannot set headers on the WebSocket handshake). */
function extractToken(req: Request): string | null {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) return header.slice(7)
  if (req.query.token) return req.query.token as string
  return null
}

/** Validates the JWT and injects username/role into res.locals. */
export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const token = extractToken(req)
  if (!token) { res.status(401).json({ error: 'unauthorized' }); return }
  const payload = verifyToken(token)
  if (!payload) { res.status(401).json({ error: 'invalid token' }); return }
  res.locals.user = payload.username
  res.locals.role = payload.role
  next()
}

/** Gate for admin-only routes — mount after authMiddleware. */
export function adminOnly(_req: Request, res: Response, next: NextFunction) {
  if (res.locals.role !== 'admin') { res.status(403).json({ error: 'forbidden' }); return }
  next()
}
