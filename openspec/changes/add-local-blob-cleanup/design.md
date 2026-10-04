## Context

The S3 migration story (change `add-s3-asset-storage`) ends with
`migrate-to-s3.js`: an idempotent copy of every local blob into the bucket
that deliberately leaves the local uploads tree in place. Until now,
reclaiming that space has been a manual `docker compose exec app rm -rf
/data/uploads/*` with no verification. The cleanup command naturally
belongs next to the migration CLI: same shape (`process.env.STORAGE_DRIVER
= 's3'` forced internally, same uploads walk, same console reporting), and
it reuses `storage().exists()` for the verification. The `assertStorageReady()`
startup check pattern shows the fail-fast style to imitate.

## Goals / Non-Goals

- Goals: a verified, dry-run-default, driver-gated cleanup CLI; clear
  reporting; zero risk to the database.
- Non-Goals: scheduled/automatic pruning, deleting the local fallback
  *during* migration (keep-both is a feature for the switchover window),
  pruning individual keys selectively, any admin-UI surface (this is an
  ops command, like the migration itself), S3 lifecycle rules.

## Decisions

- **Separate CLI (`prune-local-uploads.ts`) rather than a flag on
  `migrate-to-s3.js`**: migration (copy) and cleanup (delete) have
  different risk profiles and different verification needs; a dedicated
  command keeps each one auditable and lets an operator re-run cleanup
  months later without re-running a copy step. *Alternative*: `--prune`
  flag — hides a destructive action behind the copy tool.
- **Verification = "every local key exists in the bucket"** — exactly the
  set the migration copied, so it is independent of the database and
  catches partial/interrupted migrations. Content re-hashing is skipped:
  asset keys are already content-addressed, and comparing sizes would
  double the runtime for marginal value; the restore path (backups) is the
  recovery tool for silent corruption, not this command. *Alternative*:
  checksum comparison — too slow for large tile trees.
- **Driver gate re-reads `STORAGE_DRIVER`** (refuses unless `s3`), unlike
  the migration CLI which *forces* s3 — because cleanup's precondition is
  that the running app actually serves from S3, not merely that the envs
  are present.
- **Delete = empty the uploads tree, keep the directory** (`rm` children,
  not the tree itself) — the Docker image declares `VOLUME /data` with
  `UPLOADS_DIR=/data/uploads`, and tools expect the directory to exist.
  Tile `.tmp-*` staging dirs are included in deletion; anything matching
  restore-retirement names (`uploads.retired-*`) is reported but skipped —
  those belong to the restore feature and the admin should decide.
- **Reporting**: per the spec — count + total size (human units), missing
  keys listed (capped list, e.g. first 20) on failure, and a `--delete`
  usage hint in dry-run output. Exit codes: 0 success/dry-run-clean,
  1 verification failure or refusal.
- **Deletion mechanics**: plain `fs.rmSync` per verified file, walking the
  same tree the verification walked; empty directories pruned bottom-up.
  Order: verify ALL first, then delete — never interleaved.

## Risks / Trade-offs

- [Operator runs `--delete` before the app actually switched to s3] → The
  driver gate plus the docs ordering (migrate → switch → verify serving →
  cleanup) make this a deliberate act; even then the bucket holds
  everything, so only the fallback copy is lost.
- [Bucket completeness ≠ byte-identical objects] → Accepted: keys are
  content-addressed or immutable-named; corruption recovery is the backup
  feature's job.
- [Very large trees make `exists()` slow] → Same per-key probe the
  migration performs; sequential on purpose. Documented expectation.

## Migration Plan

Purely additive CLI; no schema/API change. Rollback = remove the file.

## Open Questions

None — the command shape, gates, and verification semantics are settled
above.
