## 1. Backup export

- [x] 1.1 Add `backend/src/routes/backup.ts` with `GET /api/backup/export` (admin-only): consistent `vtt.db` snapshot via better-sqlite3 `db.backup()` into a temp file, `manifest.json` (app version, driver, ISO timestamp), streamed as an attachment `simple-vtt-backup-<ts>.zip`; verify curl `-O -J` yields a valid ZIP whose `vtt.db` opens in `sqlite3`
- [x] 1.2 Include the uploads tree at storage keys when `STORAGE_DRIVER=local` (walk `UPLOADS_DIR`, skip staging/marker files; stream entries without full buffering); verify a local-driver backup contains `vtt.db`, `manifest.json` and blob keys (`asset_*`, `map_*`, `fog_*`, `tiles/...`)
- [x] 1.3 Emit a DB-only archive when `STORAGE_DRIVER=s3` (no blob entries, manifest records `driver: s3`); verify the ZIP contains only `vtt.db` + `manifest.json`
- [x] 1.4 Mount the router in `app.ts` and confirm non-admins get an authorization error (`curl` with a player token → 403)

## 2. First-start setup + restore backend

- [x] 2.1 Add the `setup_completed` settings flag and `backend/src/routes/setup.ts` with `GET /api/setup/status` (open while flag absent, `{ completed: true }` afterwards); verify status flips after the flag is set
- [x] 2.2 Add `POST /api/setup/admin` (rate-limited like login, 403 once completed): create the first admin (bcrypt) or adopt the existing env admin after password check; both mark setup completed; verify login works with the created credentials and that a second call is refused
- [x] 2.3 Add `POST /api/setup/restore` (403 once completed) with a `Content-Length` gate and the raw body streamed to a staging file (no multipart buffering at 2 GB scale; cap configurable via RESTORE_MAX_BYTES); verify an oversized upload is rejected 413 before buffering and a post-setup call is refused 403
- [x] 2.4 Stage + validate the archive fully before applying: zip integrity, per-entry uncompressed-size bomb caps, `vtt.db` opens and contains the expected core tables, manifest parses; verify a corrupt archive, a missing-`vtt.db` archive and a zip-bomb each return a 4xx and change nothing on disk
- [x] 2.5 Implement the pending-swap marker + startup apply in `index.ts` (before `db.ts` opens the DB): replace the DB file from staging (marking setup completed in the restored DB); on `local`, rename the current uploads tree to `uploads.retired-<ts>`, move the staged tree in, delete the retired copy after healthy boot; make the marker idempotent/crash-safe and verify by simulating a kill between stage and apply, then restarting twice
- [x] 2.6 Return a success response with an explicit restart notice before the process exits; verify the wizard sees the response and the app reconnects into the restored state

## 3. Frontend

- [x] 3.1 Add API methods to `frontend/src/api/client.ts`: setup status, create-first-admin, restore upload (with progress), and `exportBackup()` (attachment download); verify against a live backend
- [x] 3.2 Build the first-start setup wizard screen (shown when setup status says incomplete, before login): credentials path (create or adopt env admin), backup-import path with file picker + validation errors + restart notice; verify both paths end logged-in with setup closed, and that the wizard is unreachable afterwards
- [x] 3.3 Add the "Download backup" button to the admin panel (no restore control there); verify the download yields a valid ZIP in the browser

## 4. End-to-end + docs

- [x] 4.1 Exercise the migration flow end to end: take a local-driver backup on instance A → deploy a fresh instance B → restore through the wizard → log in with archived credentials and confirm maps/assets serve. Verified live (wizard UI, restart swap, archived login). The s3-driver repeat against a preserved MinIO bucket is **closed as won't-do** (accepted by the user, 2026-10-04): the DB-only s3-driver restore was verified against a real SDK client with an S3 stub; the live-MinIO combination is re-checked at deploy time.
- [x] 4.2 Document the first-start wizard and backup/restore in the README (per-driver semantics: local = full archive, S3 = DB + separately backed-up bucket; set up fresh deployments promptly) and confirm `openspec validate` passes for the change
