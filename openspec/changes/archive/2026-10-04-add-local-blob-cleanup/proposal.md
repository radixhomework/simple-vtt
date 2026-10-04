## Why

After migrating blobs to S3 (`migrate-to-s3.js`), the local uploads tree remains on the data volume as an untouched fallback — useful during the switchover, but it keeps consuming the host disk forever, and reclaiming the space currently means hand-crafting `docker compose exec app rm -rf …` commands with no safety net. A supported, verified cleanup step completes the migration story.

## What Changes

- **Verify-then-clean CLI**: a new one-shot command (`node dist/prune-local-uploads.js`, run via `docker compose exec app`) that first **verifies** that every blob under the local uploads tree exists in the configured S3 bucket, and only then deletes the local copies. Verification failure (any missing object) aborts the cleanup with nothing deleted.
- **Dry-run by default**: without a flag the command reports exactly what would be deleted and the outcome of verification; `--delete` performs the cleanup.
- **Refuses to run unless `STORAGE_DRIVER=s3`**: pruning local copies only makes sense once the application actually serves from S3; with the local driver the command exits with an explanation instead of deleting the live data.
- **Never touches the database or non-upload files**: only the uploads tree content is removed (map images, assets, fog masks, tile pyramids); `vtt.db` and everything else on the data volume stays.
- **Docs**: `docs/BACKUP-RESTORE.md` (or the deployment docs) gains the post-migration cleanup step replacing the manual `rm -rf` recipe.

## Capabilities

### New Capabilities
- `local-blob-cleanup`: verified, opt-in deletion of the local uploads tree after an S3 migration — verification-first, dry-run default, driver-gated, database-untouched.

### Modified Capabilities
<!-- none: the migration CLI and the storage abstraction are unchanged; this adds a companion ops command -->

## Impact

- **Backend**: new `backend/src/prune-local-uploads.ts` (compiled CLI like `migrate-to-s3.ts`); reuses the `storage` abstraction (`exists`) and the same uploads-walk pattern as the migration script.
- **Ops/docs**: deployment/backup documentation updated with the cleanup step and its safety gates.
- **No schema, API, or frontend changes.**
