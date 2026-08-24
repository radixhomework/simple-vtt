import { db } from './db'

export interface AppSettingsRecord {
  chat_enabled: boolean
  players_move_own_only: boolean
  fog_enabled_default: boolean
  grid_visible_default: boolean
  snap_default: boolean
  grid_square_size: number
  measurement_unit: 'ft' | 'm'
  /** Maximum accepted size of a single asset upload, in megabytes */
  max_asset_size_mb: number
  players_open_doors: boolean
  players_open_windows: boolean
}

/** Defaults used when a key is missing from the settings table. */
export const SETTINGS_DEFAULTS: AppSettingsRecord = {
  chat_enabled: true,
  players_move_own_only: true,
  fog_enabled_default: true,
  grid_visible_default: true,
  snap_default: true,
  grid_square_size: 5,
  measurement_unit: 'ft',
  max_asset_size_mb: 50,
  players_open_doors: true,
  players_open_windows: true,
}

export function loadSettings(): AppSettingsRecord {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]))
  const maxSize = Number(map.max_asset_size_mb)
  return {
    chat_enabled: map.chat_enabled !== 'false',
    players_move_own_only: map.players_move_own_only !== 'false',
    fog_enabled_default: map.fog_enabled_default !== 'false',
    grid_visible_default: map.grid_visible_default !== 'false',
    snap_default: map.snap_default !== 'false',
    grid_square_size: Number(map.grid_square_size) > 0 ? Number(map.grid_square_size) : SETTINGS_DEFAULTS.grid_square_size,
    measurement_unit: map.measurement_unit === 'm' ? 'm' : 'ft',
    max_asset_size_mb: Number.isFinite(maxSize) && maxSize >= 1 && maxSize <= 500
      ? Math.round(maxSize)
      : SETTINGS_DEFAULTS.max_asset_size_mb,
    players_open_doors: map.players_open_doors !== 'false',
    players_open_windows: map.players_open_windows !== 'false',
  }
}

/**
 * Validate an incoming patch and convert it to storable string values.
 * Unknown or invalid keys are ignored.
 */
export function sanitizeSettingsPatch(updates: Record<string, unknown>): Record<string, string> {
  const patches: Record<string, string> = {}
  for (const [key, value] of Object.entries(updates)) {
    if (!(key in SETTINGS_DEFAULTS)) continue
    switch (key) {
      case 'grid_square_size':
        if (typeof value === 'number' && value > 0) patches[key] = String(value)
        break
      case 'max_asset_size_mb':
        if (typeof value === 'number' && value >= 1 && value <= 500) patches[key] = String(Math.round(value))
        break
      case 'measurement_unit':
        if (value === 'ft' || value === 'm') patches[key] = value
        break
      default:
        if (typeof value === 'boolean') patches[key] = String(value)
        break
    }
  }
  return patches
}
