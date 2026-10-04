## Purpose

Provide a safe, supported way to reclaim local disk space after a blob
migration to S3: verify that every locally stored blob is present in the
bucket, then delete the local copies — never the database, and only ever
with an explicit opt-in.

## Requirements

### Requirement: Verified cleanup command
The system SHALL provide a one-shot cleanup command that deletes the
contents of the local uploads tree only after verifying that every local
blob exists in the configured S3 bucket. If any object is missing from the
bucket, the command SHALL delete nothing and report the missing keys.

#### Scenario: Cleanup proceeds when the bucket is complete
- **WHEN** the cleanup command runs with `--delete` and every local file
  has a corresponding object in the bucket
- **THEN** the local uploads tree is emptied (map images, shared assets,
  fog masks, tile pyramids) while the database file and the rest of the
  data volume are left untouched
- **AND** a summary reports how many blobs were verified and deleted

#### Scenario: Missing object aborts the cleanup
- **WHEN** the cleanup command runs with `--delete` and at least one local
  file has no corresponding object in the bucket
- **THEN** nothing is deleted and the command lists the missing keys and
  exits with a failure status

### Requirement: Dry-run by default
Without the delete flag, the cleanup command SHALL perform the full
verification and report exactly what would be deleted (count and total
size) without deleting anything.

#### Scenario: Dry run reports without deleting
- **WHEN** the cleanup command runs without the delete flag
- **THEN** the local uploads tree is unchanged
- **AND** the report states the number of files, their total size, and the
  verification outcome, with an indication of how to proceed to deletion

### Requirement: Cleanup is gated on the S3 driver
The cleanup command SHALL refuse to run unless the active storage driver
is `s3`, regardless of flags, because pruning local copies only makes
sense once the application serves from S3.

#### Scenario: Refusal on the local driver
- **WHEN** the cleanup command runs while `STORAGE_DRIVER` is `local` (or
  unset)
- **THEN** the command explains the requirement and exits without
  modifying anything

### Requirement: Cleanup does not affect serving or backups
Pruning the local uploads tree SHALL NOT change any URL stored in the
database nor the behavior of the application or of backups: with the s3
driver backups are database-only and all `/uploads/…` references resolve
against the bucket.

#### Scenario: Application serves normally after cleanup
- **WHEN** images, fog masks and tiles referenced by the database are
  requested after a successful cleanup
- **THEN** they are streamed from the bucket exactly as before
