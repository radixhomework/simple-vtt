import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

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
    map_offset_y   REAL NOT NULL DEFAULT 0,
    tokens_hidden  INTEGER NOT NULL DEFAULT 0
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

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`)

// Migration: add tokens_hidden to pre-existing tables databases
const tableCols = db.prepare('PRAGMA table_info(tables)').all() as Array<{ name: string }>
if (!tableCols.some(c => c.name === 'tokens_hidden')) {
  db.exec('ALTER TABLE tables ADD COLUMN tokens_hidden INTEGER NOT NULL DEFAULT 0')
}

// Seed default settings (INSERT OR IGNORE so existing values are preserved)
const seedSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
const seedAll = db.transaction(() => {
  seedSetting.run('chat_enabled',          'true')
  seedSetting.run('players_move_own_only', 'true')
  seedSetting.run('fog_enabled_default',   'true')
  seedSetting.run('grid_visible_default',  'true')
})
seedAll()
