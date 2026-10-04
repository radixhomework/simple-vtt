# Architecture — Simple VTT

Agent-facing system overview. Codebase layout, rendering pipeline and
conventions live in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); this
file covers the system shape and the invariants agents must respect.

## System shape

One Node.js process serves everything: REST API, WebSocket hub, built
frontend (SPA fallback) and blob streaming. SQLite (better-sqlite3, WAL)
is the single database; blobs live behind the storage abstraction. The
official deployment is a single Docker container with one volume
(`vtt-data` → `/data` holding `vtt.db` + `uploads/`).

```
frontend (Vite + TS, no framework, MVVM pages)
   ↓ build output → backend/public
backend/src
  index.ts        boot order: storage check → pending restore → HTTP+WS
  app.ts          Express assembly: /uploads streaming, /api routers, SPA
  hub.ts          WebSocket rooms, server-authoritative state
  db.ts           schema + idempotent migrations (runs on import)
  storage/        StorageDriver: LocalStorageDriver | S3StorageDriver
  routes/         auth, tables, tokens, portals, walls, props, assets,
                  settings, backup, setup
  restore-apply.ts  pending-restore swap (runs before db opens)
  migrate-to-s3.ts / prune-local-uploads.ts   one-shot ops CLIs
```

## Key invariants

- **Boot order is strict** (`index.ts`): `assertStorageReady()` must fail
  the start on invalid storage config *before* anything else; a pending
  restore swap happens *before* `db.ts` opens the database. The heavy
  modules are imported dynamically to preserve this order.
- **Blob keys** are the DB's `/uploads/…` URL paths minus the prefix
  (`asset_<hash>.webp`, `map_<id>.png`, `fog_<floorId>.png`,
  `tiles/<floorId>/<z>/<x>_<y>.jpg`). The database never changes format
  when the driver changes. All blob I/O goes through `storage()` — never
  direct `fs` under the uploads tree in feature code.
- **The server is authoritative** for realtime state; REST handlers push
  `table_state` via `pushTableStateToTable` after mutations that change
  what players may see.
- **Migrations**: schema changes are idempotent blocks in `db.ts` guarded
  by `PRAGMA table_info` or settings markers — never edit the CREATE
  statements for existing installs.
- **Setup flag** (`settings.setup_completed`) lives inside the database so
  it travels with backups; the setup endpoints hard-close once it exists.
- **Backups**: consistent snapshot via better-sqlite3 `db.backup()`;
  local-driver archives carry blobs at their keys, S3-driver archives are
  database-only (the bucket is backed up externally).
- **Sequential storage awaits in import/export/migration code are
  intentional** (ordering, dedup safety, gentle on the endpoint) — marked
  `// NOSONAR` rather than parallelized.

## Environments

- **Docker** (`docker compose`): main compose file forwards deployment
  envs from `.env`; `docker-compose-local.yml` keeps the local-driver
  defaults. Image builds frontend + backend stages; runtime serves on
  8080.
- **Local dev**: `backend`: `npm run dev` (tsx watch) or `tsc` + `node
  dist/index.js`; `frontend`: `npm run dev` proxies to :8080. For
  two-instance tests (backup → fresh restore) boot compiled `dist/` on
  scratch ports (180xx) with `DB_PATH`/`UPLOADS_DIR`/`JWT_SECRET`
  pointing at temp dirs.

## OpenSpec workflow

Feature work goes through OpenSpec (`openspec/`): `/opsx:propose`
creates proposal/specs/design/tasks (planning only), `/opsx:apply`
implements task-by-task, `/opsx:archive` moves a completed change to
`openspec/changes/archive/` with a date prefix. Specs describe observable
behavior; design records decisions and rejected alternatives.
