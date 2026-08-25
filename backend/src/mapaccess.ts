/**
 * Per-map access control. Every map carries a membership list: the
 * uploader is its dm, everyone else — including global admins — must be
 * invited as 'dm' or 'player'. The map role governs everything done on
 * that map; the global role only opens the admin console.
 *
 * Global admins without an invitation still resolve to dm when joining a
 * map, so their console-level "manage everything" rights are preserved;
 * an invited role always wins over the global one (an admin invited as
 * player is a player on that map).
 */
import type { Request, Response } from 'express'
import { db } from './db'

export type MapRole = 'dm' | 'player'

export function mapRole(username: string, tableId: string, globalRole: string): MapRole | null {
  const m = db.prepare('SELECT role FROM map_members WHERE table_id=? AND username=?')
    .get(tableId, username) as { role: string } | undefined
  if (m?.role === 'dm' || m?.role === 'player') return m.role
  if (globalRole === 'admin') return 'dm'
  return null
}

export function isMapDM(username: string, tableId: string, globalRole: string): boolean {
  return mapRole(username, tableId, globalRole) === 'dm'
}

export function canAccessMap(username: string, tableId: string, globalRole: string): boolean {
  return mapRole(username, tableId, globalRole) !== null
}

/** Express guard: respond 403 unless the caller is a dm of this map. */
export function requireMapDM(req: Request, res: Response, tableId?: string): boolean {
  const id = tableId ?? req.params.id
  if (isMapDM(res.locals.user, id, res.locals.role)) return true
  res.status(403).json({ error: 'map dm only' })
  return false
}

/** Express guard: respond 403 unless the caller can reach this map. */
export function requireMapAccess(req: Request, res: Response, tableId?: string): boolean {
  const id = tableId ?? req.params.id
  if (canAccessMap(res.locals.user, id, res.locals.role)) return true
  res.status(403).json({ error: 'no access to this map' })
  return false
}
