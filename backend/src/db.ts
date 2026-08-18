/**
 * SQLite database: connection, schema creation and lightweight migrations.
 * WAL journal + foreign keys are enabled for durability and cascading
 * deletes (tokens/portals/fog die with their table).
 */
import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import { decodeUploadFilename } from './filename'

const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'vtt.db')
fs.mkdirSync(path.dirname(dbPath), { recursive: true })

export const db = new Database(dbPath)

db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username      TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'player'
  );

  CREATE TABLE IF NOT EXISTS tables (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    map_image_path TEXT NOT NULL DEFAULT '',
    grid_size      INTEGER NOT NULL DEFAULT 70,
    uvt_metadata   TEXT NOT NULL DEFAULT '{}',
    map_offset_x   REAL NOT NULL DEFAULT 0,
    map_offset_y   REAL NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS tokens (
    id            TEXT PRIMARY KEY,
    table_id      TEXT NOT NULL,
    name          TEXT NOT NULL DEFAULT '',
    x             REAL NOT NULL DEFAULT 0,
    y             REAL NOT NULL DEFAULT 0,
    icon_path     TEXT NOT NULL DEFAULT '',
    has_vision    INTEGER NOT NULL DEFAULT 0,
    vision_radius REAL NOT NULL DEFAULT 6,
    size          REAL NOT NULL DEFAULT 1,
    color         TEXT NOT NULL DEFAULT '#4a90d9',
    owner         TEXT NOT NULL DEFAULT '',
    hidden        INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (table_id) REFERENCES tables(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS portals (
    id       TEXT PRIMARY KEY,
    table_id TEXT NOT NULL,
    x1       REAL NOT NULL,
    y1       REAL NOT NULL,
    x2       REAL NOT NULL,
    y2       REAL NOT NULL,
    closed   INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (table_id) REFERENCES tables(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS fog_points (
    id       TEXT PRIMARY KEY,
    table_id TEXT NOT NULL,
    x        REAL NOT NULL,
    y        REAL NOT NULL,
    radius   REAL NOT NULL DEFAULT 3,
    FOREIGN KEY (table_id) REFERENCES tables(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS assets (
    id     TEXT PRIMARY KEY,
    kind   TEXT NOT NULL CHECK (kind IN ('image','audio')),
    name   TEXT NOT NULL,
    hash   TEXT NOT NULL,
    path   TEXT NOT NULL,
    size   INTEGER NOT NULL DEFAULT 0,
    folder TEXT NOT NULL DEFAULT '',
    UNIQUE (kind, hash)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`)

// ── Migrations for databases created before a column existed ─────────────────
const tokenCols = db.prepare('PRAGMA table_info(tokens)').all() as Array<{ name: string }>
if (!tokenCols.some(c => c.name === 'hidden')) {
  db.exec('ALTER TABLE tokens ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0')
}

// Migration: the standalone music table became the shared assets table
// (kind='audio'); copy the rows then drop it.
const musicTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='music'").get()
if (musicTable) {
  db.exec(`INSERT OR IGNORE INTO assets (id, kind, name, hash, path, size, folder)
           SELECT id, 'audio', name, '', path, 0, '' FROM music`)
  db.exec('DROP TABLE music')
}

// Migration: asset folders
const assetCols = db.prepare('PRAGMA table_info(assets)').all() as Array<{ name: string }>
if (!assetCols.some(c => c.name === 'folder')) {
  db.exec("ALTER TABLE assets ADD COLUMN folder TEXT NOT NULL DEFAULT ''")
}

// Migration: repair asset and table names mangled by the latin1 decoding of
// multipart filenames (accents and other non-ASCII characters). Idempotent:
// already-correct names round-trip to U+FFFD and are left alone.
const repairNames = db.transaction((table: string) => {
  const rows = db.prepare(`SELECT id, name FROM ${table}`).all() as Array<{ id: string; name: string }>
  const update = db.prepare(`UPDATE ${table} SET name=? WHERE id=?`)
  for (const row of rows) {
    const fixed = decodeUploadFilename(row.name)
    if (fixed !== row.name) update.run(fixed, row.id)
  }
})
repairNames('assets')
repairNames('tables')

// Seed default settings (INSERT OR IGNORE so existing values are preserved)
const seedSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
const seedAll = db.transaction(() => {
  seedSetting.run('chat_enabled',          'true')
  seedSetting.run('players_move_own_only', 'true')
  seedSetting.run('fog_enabled_default',   'true')
  seedSetting.run('grid_visible_default',  'true')
  seedSetting.run('snap_default',          'true')
  seedSetting.run('grid_square_size',      '5')
  seedSetting.run('measurement_unit',      'ft')
})
seedAll()
