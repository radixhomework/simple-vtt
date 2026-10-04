## Purpose

Provide whole-instance backup and restore: an admin can download a single
archive holding the application state (embedded database and, for local blob
storage, its blobs), and a freshly deployed instance can be brought back to
that state — or started from scratch — through a one-time first-start setup
wizard.

## ADDED Requirements

### Requirement: Instance backup download
The system SHALL allow an authenticated admin to download a ZIP backup of
the whole instance containing a consistent snapshot of the SQLite database
(`vtt.db`), taken while the application keeps running. The backup filename
SHOULD carry a timestamp (e.g. `simple-vtt-backup-20261002-153045.zip`).

#### Scenario: Admin downloads a backup
- **WHEN** an admin requests the instance backup
- **THEN** the server streams a ZIP containing `vtt.db` reflecting a
  transactionally consistent point-in-time state (including all tables:
  users, tables, floors, tokens, settings, assets index)
- **AND** the response is delivered as an attachment download

#### Scenario: Backup is admin-only
- **WHEN** a non-admin user requests the instance backup
- **THEN** the server responds with an authorization error and no archive
  is produced

### Requirement: Backup reflects the active storage driver
The backup contents SHALL depend on the active blob-storage driver:
with the `local` driver the archive SHALL include every blob under the
uploads tree (map images, shared assets, fog masks, tile pyramids) at their
storage keys; with the `s3` driver the archive SHALL contain the database
only, since the database's upload references resolve against the bucket.

#### Scenario: Local-driver backup includes blobs
- **WHEN** a backup is produced while `STORAGE_DRIVER=local`
- **THEN** the archive contains the database and the uploads tree at their
  storage keys

#### Scenario: S3-driver backup is database-only
- **WHEN** a backup is produced while `STORAGE_DRIVER=s3`
- **THEN** the archive contains the database and no blob entries
- **AND** importing that archive on a new instance configured for the same
  bucket yields a fully working instance without re-uploading any blob

### Requirement: First-start setup wizard
The system SHALL detect, at application start and before login, whether
initial setup has been completed. While setup is not completed, the
application SHALL present a one-time setup wizard to any visitor, offering
exactly two paths: create the first administrator account (username and
password), or import a previous instance backup. When the environment
bootstrap admin already exists (env-configured credentials), the wizard
SHALL allow adopting it. Completing either path SHALL mark setup as
completed (in the database, so the flag travels inside backups), after
which the wizard MUST be closed on every subsequent start.

#### Scenario: Wizard appears only on first start
- **WHEN** a visitor opens a freshly deployed instance whose setup flag is
  absent
- **THEN** the setup wizard is presented instead of the login page
- **WHEN** setup has been completed (or a backup carrying the flag has been
  imported)
- **THEN** subsequent visits go straight to the login page and the wizard
  is no longer reachable

#### Scenario: First admin created through the wizard
- **WHEN** the operator chooses the credentials path and submits a username
  and password
- **THEN** an admin account with a bcrypt-hashed password is created, setup
  is marked completed, and the operator is logged in

#### Scenario: Environment bootstrap admin adopted
- **WHEN** the environment-configured admin already exists and the operator
  adopts it through the wizard with the matching credentials
- **THEN** setup is marked completed and the operator is logged in

### Requirement: Backup import during first-start setup
While setup is not completed, the setup endpoints SHALL accept a backup ZIP
and replace the instance state: the server SHALL validate the archive
structure before applying anything, stage the database and blobs, apply the
swap, and restart the application into the restored state. Once setup is
completed, the setup restore endpoint MUST refuse every request.

#### Scenario: Operator restores a backup through the wizard
- **WHEN** a valid backup archive is uploaded during first-start setup
- **THEN** the server stages it, replaces the database (and, on the local
  driver, the uploads tree) with the archived content, and the instance
  restarts showing the restored tables, tokens, settings and users
- **AND** the operator re-authenticates with the restored credentials

#### Scenario: Invalid archive is rejected atomically
- **WHEN** an archive without a usable database entry, or a truncated or
  corrupt archive, is uploaded during setup
- **THEN** the server rejects it with a client error before any state is
  replaced, and the wizard remains available

#### Scenario: Setup restore is closed after setup
- **WHEN** setup is completed and a request reaches the setup restore
  endpoint
- **THEN** the server refuses it without applying anything

### Requirement: Setup endpoints are abuse-resistant
The first-start setup endpoints are unauthenticated by nature and therefore
SHALL be rate-limited like the login endpoint, and SHALL stop accepting
admin creation and restore requests permanently once setup is completed.

#### Scenario: Rate-limited like login
- **WHEN** a client sends repeated failed setup or restore attempts
- **THEN** further requests are throttled like repeated failed logins

### Requirement: Local-driver restore replaces blobs
When a backup produced with the `local` driver is imported during setup on
an instance running the `local` driver, the system SHALL replace the
uploads tree content with the archived blobs so the restored database
references resolve.

#### Scenario: Restored blobs match the restored database
- **WHEN** a local-driver backup is imported through the setup wizard
- **THEN** every uploaded image, fog mask and tile referenced by the
  restored database is served again from the new uploads tree
