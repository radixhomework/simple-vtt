## 1. Cleanup CLI

- [x] 1.1 Add `backend/src/prune-local-uploads.ts` (compiled CLI alongside `migrate-to-s3.ts`): refuse unless `STORAGE_DRIVER=s3` with an explanatory message; walk the uploads tree collecting files (skipping `uploads.retired-*` siblings, which are reported but kept) and verify every key with `storage().exists()`; verify ALL before deleting anything; verify compile with `npm run build`
- [x] 1.2 Dry-run mode (default): print count + total size in human units, verification outcome, first missing keys (cap 20) on failure, and a `--delete` hint; exit 1 when verification fails; verify against a seeded local tree
- [x] 1.3 `--delete` mode: after full verification, delete each verified file (`fs.rmSync`), prune emptied directories bottom-up, keep the uploads directory itself and the database; print the deleted summary; verify live that the tree is empty, `vtt.db` untouched, and the app still serves images from S3
- [x] 1.4 Missing-object abort: delete one object from the bucket, run `--delete`, confirm nothing local is deleted, the missing key is listed, and exit status is 1
- [x] 1.5 Driver gate: run with `STORAGE_DRIVER=local` (both modes) and confirm refusal with explanation, nothing modified

## 2. Docs

- [x] 2.1 Add the post-migration cleanup step (migrate → switch → verify serving → `docker compose exec app node dist/prune-local-uploads.js` → `--delete`) to `docs/BACKUP-RESTORE.md` (or DEPLOY.md) replacing the manual `rm -rf` recipe, and confirm `openspec validate` passes for the change
