## Why

All maps, tiles, fog masks and shared assets live in a single Docker volume
(`/data/uploads`). That couples the asset collection to one server host,
makes the volume grow without bound, and leaves durability to manual Docker
volume management. The user already operates a MinIO (S3-compatible) server
on a gigabit LAN machine with plenty of space.

## What Changes

- Introduce a storage abstraction (`put` / `get` / `getStream` / `delete` /
  `exists`) with two drivers: `local` (current filesystem behavior, the
  default) and `s3` (MinIO or any S3-compatible endpoint).
- All blob keys are the existing URL paths minus the `/uploads/` prefix
  (asset files, floor images, fog masks, tile pyramid files) — no data-model
  change; the DB keeps storing `/uploads/...` paths.
- The serving route streams S3 objects through the app to the browser
  (proxy mode, `Cache-Control: immutable`), with presigned URLs documented
  as a future upgrade path.
- A migration command copies the existing local volume into the bucket once.
- Deletion paths (table/floor cascade, asset delete, tile cleanup) delete
  from the active driver; the fog-mask reset deletes its mask object.

## Non-goals

- Presigned URLs (documented future upgrade — behaviorally transparent).
- CDN placement.
- Migrating the SQLite database itself — only blob storage moves.

## Capabilities

- `s3-asset-storage` (new spec, delta in this change)
