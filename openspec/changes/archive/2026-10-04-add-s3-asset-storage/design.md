# Design: add-s3-asset-storage

## Context

Twelve-plus call sites touch uploads files directly (`fs.readFileSync`,
`fs.writeFileSync`, `fs.existsSync`, `fs.unlinkSync`, `fs.createWriteStream`)
across `routes/assets.ts`, `routes/tables.ts`, `routes/tokens.ts`,
`routes/walls.ts`, `models/map-package.model.ts` and `tiles.ts`. The DB
stores stable `/uploads/<key>` URL paths; assets already carry content
hashes. Deployment is a single Docker container; the user operates a MinIO
server on a gigabit LAN.

## Approach

- **Interface, not call-site churn**: one `storage` module
  (`backend/src/storage/index.ts`) exposing
  `put(key, data)` / `getStream(key)` / `get(key)` / `delete(key)` /
  `exists(key)`, backed by `LocalStorageDriver` (current fs behavior) or
  `S3StorageDriver` (`@aws-sdk/client-s3`), selected by `STORAGE_DRIVER`.
  Call sites switch from `fs.*` to `storage.*` with the `/uploads/` prefix
  stripped as the key — mechanical, greppable.
- **Serving**: the `/uploads/:key` route streams via `getStream` with
  `Cache-Control: immutable` (keys are content-addressed, so the URL is the
  version). No buffering on the serving path; server-side consumers that
  need whole bytes (ZIP assembly, sharp, hashing) use `get`.
- **Keys keep the existing layout**: `asset_*`, `map_*`, `fog_*`,
  `tiles/<floor>/…` — the DB needs zero migration.
- **MinIO is callable-only** (busboy lesson from this codebase's history:
  `require('busboy')` returns a callable, not a constructor): instantiate
  the S3Client per driver instance, not per call.
- **Delete safety**: content-addressed objects may be referenced by multiple
  asset rows (legacy naming); deletion keeps the existing
  "last-reference-wins" check before removing the object.

## Risks / trade-offs

- **Truncation on storage failure mid-stream** — accepted: the response
  terminates and the failure is logged; the browser re-fetches on reload.
- **aws-sdk size**: adds ~10 MB to the image; acceptable, and the import is
  already ~95 MB.
- **Fog-mask read-after-write**: S3 and MinIO are strongly consistent —
  safe.
- **Windows/WSL context staleness** (observed in this environment): build
  contexts occasionally serve stale files from the D: drive; mitigations:
  `touch` + `sync` before building, or build from a WSL-side copy.

## Migration

`migrate-to-s3` CLI command: walk the local uploads dir, `put` every file
under its relative key, skip objects already in the bucket (head check),
log a summary. Run once after switching `STORAGE_DRIVER`; the local dir
stays as a fallback until manually cleaned.
