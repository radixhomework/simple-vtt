import { db } from './db'

/**
 * Two settings tiers:
 * - Global (AppSettingsRecord): installation-wide, admin console Settings
 *   tab. Currently only the asset upload limit.
 * - Per-map (TableSettingsRecord): gameplay and display defaults stored on
 *   each table, edited from the admin console's Maps & Tables page and
 *   applied live to that map's room only.
 */

export interface AppSettingsRecord {
  /** Maximum accepted size of a single asset upload, in megabytes */
  max_asset_size_mb: number
}

/** Defaults used when a key is missing from the settings table. */
export const SETTINGS_DEFAULTS: AppSettingsRecord = {
  max_asset_size_mb: 50,
}

export function loadSettings(): AppSettingsRecord {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]))
  const maxSize = Number(map.max_asset_size_mb)
  return {
    max_asset_size_mb: Number.isFinite(maxSize) && maxSize >= 1 && maxSize <= 500
      ? Math.round(maxSize)
      : SETTINGS_DEFAULTS.max_asset_size_mb,
  }
}

/** Per-map gameplay and display settings (columns on the tables row). */
export interface TableSettingsRecord {
  chat_enabled: boolean
  players_move_own_only: boolean
  players_open_doors: boolean
  players_open_windows: boolean
  snap_default: boolean
  fog_enabled_default: boolean
  grid_visible_default: boolean
  /** Real-world size of one grid square, in measurement_unit */
  grid_square_size: number
  measurement_unit: 'ft' | 'm'
}

export const TABLE_SETTINGS_DEFAULTS: TableSettingsRecord = {
  chat_enabled: true,
  players_move_own_only: true,
  players_open_doors: true,
  players_open_windows: true,
  snap_default: true,
  fog_enabled_default: true,
  grid_visible_default: true,
  grid_square_size: 5,
  measurement_unit: 'ft',
}

const TABLE_SETTINGS_COLS = 'chat_enabled, players_move_own_only, players_open_doors, players_open_windows, snap_default, fog_enabled_default, grid_visible_default, grid_square_size, measurement_unit'

export function loadTableSettings(tableId: string): TableSettingsRecord {
  const row = db.prepare(`SELECT ${TABLE_SETTINGS_COLS} FROM tables WHERE id=?`)
    .get(tableId) as Record<string, unknown> | undefined
  if (!row) return { ...TABLE_SETTINGS_DEFAULTS }
  const bool = (v: unknown) => v === 1 || v === true
  return {
    chat_enabled: bool(row.chat_enabled),
    players_move_own_only: bool(row.players_move_own_only),
    players_open_doors: bool(row.players_open_doors),
    players_open_windows: bool(row.players_open_windows),
    snap_default: bool(row.snap_default),
    fog_enabled_default: bool(row.fog_enabled_default),
    grid_visible_default: bool(row.grid_visible_default),
    grid_square_size: Number(row.grid_square_size) > 0 ? Number(row.grid_square_size) : TABLE_SETTINGS_DEFAULTS.grid_square_size,
    measurement_unit: row.measurement_unit === 'm' ? 'm' : 'ft',
  }
}

/**
 * Validate an incoming per-map patch and convert it to column → SQL value.
 * Unknown or invalid keys are ignored.
 */
export function sanitizeTableSettingsPatch(updates: Record<string, unknown>): Record<string, number | string> {
  const patches: Record<string, number | string> = {}
  for (const [key, value] of Object.entries(updates)) {
    if (!(key in TABLE_SETTINGS_DEFAULTS)) continue
    switch (key) {
      case 'grid_square_size':
        if (typeof value === 'number' && value > 0) patches[key] = value
        break
      case 'measurement_unit':
        if (value === 'ft' || value === 'm') patches[key] = value
        break
      default:
        if (typeof value === 'boolean') patches[key] = value ? 1 : 0
        break
    }
  }
  return patches
}

/**
 * Validate an incoming global patch and convert it to storable string values.
 * Unknown or invalid keys are ignored.
 */
export function sanitizeSettingsPatch(updates: Record<string, unknown>): Record<string, string> {
  const patches: Record<string, string> = {}
  for (const [key, value] of Object.entries(updates)) {
    if (!(key in SETTINGS_DEFAULTS)) continue
    if (key === 'max_asset_size_mb' && typeof value === 'number' && value >= 1 && value <= 500) {
      patches[key] = String(Math.round(value))
    }
  }
  return patches
}
