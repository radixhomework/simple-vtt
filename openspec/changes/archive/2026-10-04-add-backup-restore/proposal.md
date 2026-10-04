## Why

Moving Simple VTT to a new host currently means manual reconstruction: exporting each map, re-uploading assets, and re-creating users and settings by hand. The embedded SQLite database plus the blob store *are* the whole application state — a single downloadable backup (and a matching restore path) turns migration and disaster recovery into a two-step operation, which matters now that blob storage may live either on the local volume or in an S3 bucket.

## What Changes

- **Backup (download)**: a new admin-only endpoint streams a ZIP containing a consistent copy of the SQLite database plus — when the active storage driver is `local` — every blob under the uploads tree (maps, assets, fog masks, tile pyramids). When the driver is `s3`, the backup contains the database only: the DB's `/uploads/...` references resolve against the bucket, which is backed up by the object store's own tooling.
- **Restore (first-start setup wizard)**: on the very first start of the application, before any admin account has been set up, the app presents a setup wizard offering two paths: create the first admin account (username + password), or import a previous backup file. Once setup completes — through either path — the wizard is closed permanently. Restores therefore happen exactly once, at instance birth, replacing the whole database and (on the local driver) the blob tree.
- **Admin console UI**: the admin panel gains a "Download backup" control. Restore is intentionally not exposed in the admin panel — it lives only in the first-start wizard.

## Capabilities

### New Capabilities
- `instance-backup-restore`: whole-instance backup download (admin-only) and first-start setup wizard (first admin creation or backup import), covering both storage drivers.

### Modified Capabilities
<!-- none: map-export-import (per-map packages + asset library) is unchanged; this change adds a separate whole-instance mechanism -->

## Impact

- **Backend**: new `backend/src/routes/backup.ts` (admin-only export) and `backend/src/routes/setup.ts` (unauthenticated-but-gated first-start endpoints: status, create admin, restore) mounted in `app.ts`; consistent DB snapshot via the better-sqlite3 backup API (WAL-safe); ZIP assembly/parsing reuses the existing package patterns (`map-package.model.ts`, busboy-style multipart handling with explicit size limits).
- **Storage**: backup content depends on the active driver from `backend/src/storage` (`local` → include blobs; `s3` → DB only).
- **Restore application**: DB file swap + blob staging applied at startup (before `db.ts` opens the database), followed by a controlled process exit so the supervisor restarts into restored state.
- **Frontend**: new first-start setup wizard screen (gated by a setup-status check at login time), a "Download backup" button in the admin panel (new API methods in `src/api/client.ts`).
- **Ops/docs**: README note on backup/restore usage per storage driver and on the first-start wizard.
