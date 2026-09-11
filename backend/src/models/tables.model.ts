/**
 * MODEL — table, floor and membership persistence (MVC).
 *
 * Owns every SQL touching `tables`, `floors` and `map_members` plus the
 * invariants attached to them (dimension consistency across floors, member
 * uniqueness). Routes act as controllers: they authorize, then delegate
 * here. The hub reads the same functions so game state always flows through
 * one data layer.
 */
import { db } from '../db'

export const TABLE_COLS = 'id, name, owner, default_floor_id'
export const FLOOR_COLS = 'id, table_id, level, name, map_image_path, grid_size, uvt_metadata, map_offset_x, map_offset_y, img_width, img_height, tiles_path, revealed'

export interface TableRow {
  id: string; name: string; owner: string; default_floor_id: string
}

export interface FloorRow {
  id: string; table_id: string; level: number; name: string
  map_image_path: string; grid_size: number; uvt_metadata: string
  map_offset_x: number; map_offset_y: number; img_width: number; img_height: number
  tiles_path: string
  revealed: number
}

export interface MapMemberRow {
  table_id: string; username: string; role: 'dm' | 'player'
}

export function getTable(id: string): TableRow | undefined {
  return db.prepare(`SELECT ${TABLE_COLS} FROM tables WHERE id=?`).get(id) as TableRow | undefined
}

export function getFloor(id: string): FloorRow | undefined {
  return db.prepare(`SELECT ${FLOOR_COLS} FROM floors WHERE id=?`).get(id) as FloorRow | undefined
}

export function floorsOf(tableId: string): FloorRow[] {
  return db.prepare(`SELECT ${FLOOR_COLS} FROM floors WHERE table_id=? ORDER BY level, rowid`).all(tableId) as FloorRow[]
}

export function listTablesFor(username: string, isAdmin: boolean): Array<TableRow & { floor_count: number; image_count: number; token_count: number; portal_count: number }> {
  const counts = `,
    (SELECT COUNT(*) FROM floors  WHERE table_id = t.id) AS floor_count,
    (SELECT COUNT(*) FROM floors  WHERE table_id = t.id AND map_image_path <> '') AS image_count,
    (SELECT COUNT(*) FROM tokens  WHERE table_id = t.id) AS token_count,
    (SELECT COUNT(*) FROM portals WHERE table_id = t.id) AS portal_count`
  const rows = isAdmin
    ? db.prepare(`SELECT t.id, t.name, t.owner${counts} FROM tables t ORDER BY t.rowid DESC`).all()
    : db.prepare(`SELECT t.id, t.name, t.owner${counts} FROM tables t JOIN map_members m ON m.table_id = t.id WHERE m.username = ? ORDER BY t.rowid DESC`).all(username)
  return rows as Array<TableRow & { floor_count: number; image_count: number; token_count: number; portal_count: number }>
}

/**
 * The dimension reference of a table: the lowest floor with a known image
 * size. Returns null while no floor declares one (legacy data), in which
 * case the check is skipped.
 */
export function dimensionRef(tableId: string): { w: number; h: number } | null {
  const row = db.prepare(
    'SELECT img_width AS w, img_height AS h FROM floors WHERE table_id=? AND img_width>0 AND img_height>0 ORDER BY level, rowid LIMIT 1'
  ).get(tableId) as { w: number; h: number } | undefined
  return row ? { w: row.w, h: row.h } : null
}

/** All floor images must share dimensions so coordinates map 1:1 across levels. */
export function checkDimensions(tableId: string, w: number, h: number): string | null {
  if (!w || !h) return null // unknown → nothing to compare against
  const ref = dimensionRef(tableId)
  if (ref && (ref.w !== w || ref.h !== h)) {
    return `floor images must all be ${ref.w}×${ref.h}px (got ${w}×${h})`
  }
  return null
}

// ── Members ───────────────────────────────────────────────────────────────────
export function membersOf(tableId: string): MapMemberRow[] {
  return db.prepare('SELECT username, role FROM map_members WHERE table_id=? ORDER BY role, username').all(tableId) as MapMemberRow[]
}

export function setMember(tableId: string, username: string, role: 'dm' | 'player'): void {
  db.prepare('INSERT INTO map_members (table_id, username, role) VALUES (?,?,?) ON CONFLICT(table_id, username) DO UPDATE SET role=excluded.role')
    .run(tableId, username, role)
}

export function removeMember(tableId: string, username: string): boolean {
  return db.prepare('DELETE FROM map_members WHERE table_id=? AND username=?').run(tableId, username).changes > 0
}

export function userExists(username: string): boolean {
  return !!db.prepare('SELECT username FROM users WHERE username=?').get(username)
}
