## Context

State lives in two places: the SQLite database (`DB_PATH`, WAL-journaled,
better-sqlite3, opened once in `backend/src/db.ts` and imported everywhere)
and the blob store behind `backend/src/storage` (`local` filesystem driver
under `UPLOADS_DIR`, or `s3`). Blob keys are the DB URL paths minus the
`/uploads/` prefix, so a database plus the blobs it references is a complete,
self-describing instance. Users are DB rows (bcrypt) with the
environment admin doubling as a recovery backdoor at login time; auth.ts
already bootstraps that env admin on every start. Existing precedents:
`map-package.model.ts` (ZIP build/parse), busboy-style multipart handling
with explicit size gates (fog-mask PUT), and the `loginLimiter` rate
limiter in `backend/src/ratelimit`.

## Goals / Non-Goals

- Goals: one-file backup/restore round trip; driver-aware contents;
  first-start setup that ends with either a first admin or a restored
  instance; no downtime required to *take* a backup.
- Non-Goals: scheduled/automatic backups, backing up the S3 bucket itself
  (the object store's tooling owns that), restore from the admin panel or
  after first start (the wizard is the only restore path), partial/
  table-selective restore, cross-version restore guarantees beyond "same or
  newer application version".

## Decisions

- **Consistent DB snapshot: better-sqlite3 `db.backup(dest)`** — the async
  backup API pages the WAL into a standalone snapshot file while the app
  keeps serving; safe with `journal_mode=WAL` where copying or
  `VACUUM INTO` mid-write risks tear or long write locks. *Alternative*:
  `VACUUM INTO` (blocks writers for the duration) or raw file copy
  (corrupt under WAL).
- **Archive layout: flat ZIP, `vtt.db` at root + blobs at their storage
  keys** (`asset_x.webp`, `tiles/<floorId>/2/3_4.jpg`, …). The DB needs no
  rewriting on restore and the layout matches the local driver's key space
  exactly. A `manifest.json` (version, driver, timestamps) rides along for
  diagnostics and forward compatibility.
- **S3 driver → DB-only archive**: keys are stable content-addressed names
  and the bucket is expected to outlive any single app instance; duplicating
  potentially gigabytes of tiles into the ZIP is waste. The admin docs state
  the bucket must be backed up separately. *Alternative* (rejected): inline
  bucket objects into every backup — balloon size, slow, doubles egress
  cost.
- **Setup gating: `setup_completed` flag in the `settings` table** — the
  wizard is served when the flag is absent. The flag lives in the database
  so it travels inside backups: importing an old backup (or the restore
  apply itself) marks setup completed as part of the swap, preventing a
  wizard re-appearance after restore. The existing `ensureAdmin()` env
  bootstrap keeps running unchanged; it does not by itself complete setup —
  the wizard's credentials path detects the existing env admin and offers
  "adopt it" (verify password, mark completed). *Alternative*: gate on
  "users table empty" — breaks as soon as any code path creates a user and
  is fuzzy about restored databases.
- **Setup routes: `GET /api/setup/status`, `POST /api/setup/admin`,
  `POST /api/setup/restore`** — all gated by the flag (403 once completed)
  and mounted on the same stricter limiter as login, since they are
  unauthenticated by nature. The frontend decides wizard-vs-login from
  `GET /api/setup/status`. *Alternative*: a dedicated `/setup` SPA route
  alone — insufficient, the API must be gated server-side.
- **Restore = stage, validate, swap, exit**: the wizard's upload streams to
  a staging dir; the archive is fully validated (zip integrity, `vtt.db`
  opens via better-sqlite3, required tables present) *before* anything is
  replaced. The staging dir is then recorded in a marker file next to
  `DB_PATH` and the process exits; on boot, `index.ts` applies the pending
  swap (replace DB file; on `local` rename-aside the uploads tree) *before*
  `db.ts` opens the database. The container restart policy brings the app
  back — same trick the deploy flow already uses. *Alternative* (rejected):
  hot-swapping the DB file under open better-sqlite3 handles — undefined
  behavior with WAL.
- **Blob swap on restore: rename-aside, then delete** — the old uploads
  tree is renamed `uploads.retired-<ts>` and the staged tree moves in; the
  old copy is deleted after successful startup. Rollback within one restart
  is therefore free.
- **Upload gating**: restore uploads get a declared `Content-Length` gate
  and a streamed busboy-style parse with a generous cap (e.g. 2 GB,
  configurable) — same pattern as the fog-mask PUT, scaled up; ZIP entries
  are individually size-checked against zip-bomb heuristics (total
  uncompressed cap).
- **Backup export route**: `GET /api/backup/export` (adminOnly middleware
  from `backend/src/auth`) in `backend/src/routes/backup.ts`, mirroring the
  existing router layout.

## Risks / Trade-offs

- [Unauthenticated setup window on first boot] → The wizard exists exactly
  once per instance and only before any admin exists; endpoints are
  rate-limited like login and hard-closed by the `setup_completed` flag; a
  fresh deployment should be set up promptly (documented).
- [Restore requires a restart] → The wizard communicates this up front; the
  supervisor restart is automatic.
- [Large local-driver instances → multi-GB ZIPs] → Streaming assembly
  (archiver writes to the response as it goes, nothing fully buffered);
  documented expectation that S3-driver sites don't carry blobs in backups.
- [Admin imports a backup from an older app version] → Manifest carries the
  producing version; restore validates required tables and refuses with a
  clear error rather than booting broken.
- [Half-applied swap on power loss during restart] → The marker file is
  written only after full validation and applied idempotently (a leftover
  marker re-runs the swap; a completed marker is consumed).

## Migration Plan

Purely additive: new routes, new startup hook, one wizard screen, one admin
button. No DB schema change (the setup flag is a settings row). Rollback =
remove the feature branch; backups taken by the feature are ordinary ZIPs
usable by manual means (unzip + file copy).

## Open Questions

None — the wizard-vs-admin-panel restore question is settled by the user's
direction (wizard only, first start only), and the driver-dependent backup
contents are settled above.
