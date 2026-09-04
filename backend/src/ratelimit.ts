/**
 * In-memory API rate limiting (express-rate-limit). Two tiers:
 *
 * - apiLimiter — generous global cap for authenticated /api traffic.
 *   The interactive VTT runs over the WebSocket and is unaffected; this
 *   only bounds REST abuse (runaway scripts, hammering endpoints).
 * - loginLimiter — strict per-IP cap on credential attempts to blunt
 *   brute-force attacks against /auth/login.
 *
 * Keys: username when authenticated, client IP otherwise (X-Forwarded-For
 * is trusted for one hop — we sit behind the Apache reverse proxy).
 */
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import type { Request, Response } from 'express'

/** 429 as JSON; standard headers (draft-7) already carry the retry timing. */
function jsonHandler(_req: Request, res: Response) {
  res.status(429).json({ error: 'too many requests, retry later' })
}

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300, // 5 req/s sustained — far above normal interactive use
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req, res) => (res.locals.user as string | undefined) ?? ipKeyGenerator(req.ip ?? 'unknown'),
  handler: jsonHandler,
})

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10, // 10 attempts per 15 minutes per IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: jsonHandler,
})
