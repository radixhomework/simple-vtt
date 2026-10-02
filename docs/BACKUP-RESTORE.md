# Backup & restore

Simple VTT's entire state lives in two places: the embedded SQLite
database and its blob store (uploaded maps, assets, fog masks, tiles).
One ZIP archive captures both, and a fresh instance can be brought back
to that state through the first-start setup wizard.

## Downloading a backup

Sign in as admin → **⚙ Settings → Backup → Download backup**.

The archive contains:

- `vtt.db` — a consistent snapshot of the database (users, maps, tokens,
  settings, asset index), taken while the app keeps running;
- `manifest.json` — producing version, storage driver, timestamp;
- with **local storage** (`STORAGE_DRIVER=local`, the default): every
  uploaded file at its storage key (`asset_*`, `map_*`, `fog_*`,
  `tiles/…`).

With **S3 storage** (`STORAGE_DRIVER=s3`) the archive is database-only:
the database's `/uploads/…` references resolve against the bucket, so the
bucket itself must be backed up with your object store's tooling
(`mc mirror`, lifecycle rules, …). Keeping the bucket across deployments
means a database-only backup restores a fully working instance.

## Restoring on a fresh deployment

Restore happens through the **first-start setup wizard**: a brand-new
instance (no tables, no assets, no users beyond the environment
bootstrap admin) shows it instead of the login page. The wizard offers:

1. **Create the first admin** — pick a username and password. If an
   environment-configured admin already exists (`ADMIN_USERNAME` /
   `ADMIN_PASSWORD`), submitting those credentials adopts it.
2. **Import a backup file** — upload a backup ZIP. The archive is
   validated in full before anything is replaced; the server then swaps
   the database (and, for local storage, the uploaded files) and
   restarts into the restored state. Log in afterwards with the
   *archived* credentials.

Once setup completes — through either path — the wizard is closed
permanently; the flag lives in the database and therefore travels inside
backups. Restore is intentionally not available from the admin panel.

Notes:

- Existing installations upgraded from before the wizard automatically
  count as set up (a one-time migration marks them complete) — the
  wizard only ever appears on truly fresh deployments.
- Set up fresh deployments promptly: the setup endpoints are
  unauthenticated by nature (rate-limited like login, and hard-closed
  after setup).
- Large libraries make large archives: local-driver backups carry every
  uploaded file; S3-driver ones are small.
