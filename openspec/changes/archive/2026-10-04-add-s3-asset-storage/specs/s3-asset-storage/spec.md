## ADDED Requirements

### Requirement: Storage driver selection
The system SHALL expose a blob-storage abstraction with `local` and `s3`
drivers, selected by the `STORAGE_DRIVER` environment variable (`local` is
the default), with the S3 endpoint, bucket and credentials configured in
the environment, and SHALL use the active driver for every blob read,
write and delete.

#### Scenario: Default driver is local
- **WHEN** no `STORAGE_DRIVER` is configured
- **THEN** blobs are stored on the local filesystem exactly as before the
  change

#### Scenario: S3 driver selected
- **WHEN** `STORAGE_DRIVER=s3` is configured with a reachable S3 endpoint
- **THEN** every blob write, read and delete is served by the S3 driver

### Requirement: Blob writes go to the active driver
The system SHALL write every new blob (asset files, floor map images, fog
masks, tile-pyramid files) through the active storage driver, keyed by the
existing URL path minus the `/uploads/` prefix, without changing any
database path format.

#### Scenario: Asset upload with S3 driver
- **WHEN** a user uploads an asset while the S3 driver is active
- **THEN** the object is stored in the configured bucket under the same key
  the local driver would have used, and the DB path remains `/uploads/<key>`

#### Scenario: Fog mask written on import
- **WHEN** a map package with fog masks is imported while the S3 driver is
  active
- **THEN** every mask is stored as an object keyed `fog_<floorId>.png`

### Requirement: Blob serving streams from the active driver
The system SHALL serve blob requests to `/uploads/<key>` by streaming the
object from the active storage driver to the browser, with
`Cache-Control: immutable` set (asset keys are content-addressed), without
buffering the whole object in server memory.

#### Scenario: Browser fetches a map image
- **WHEN** a browser requests a floor map image
- **THEN** the server streams the object bytes from storage to the browser
  with an immutable cache header

#### Scenario: S3 failure mid-stream
- **WHEN** the storage connection fails while streaming
- **THEN** the response is terminated (truncated) and the failure is logged

### Requirement: Delete propagates to the active driver
The system SHALL delete the corresponding object from the active storage
driver whenever a blob's owning entity is removed (asset delete, table or
floor cascade, tile cleanup, fog reset), without touching objects that
other entries still reference.

#### Scenario: Asset deleted with S3 driver
- **WHEN** an asset is deleted while the S3 driver is active
- **THEN** its object is removed from the bucket

#### Scenario: Shared file preserved
- **WHEN** two asset entries reference the same content-addressed object
  and one is deleted
- **THEN** the object stays in storage until the last referencing entry is
  deleted

### Requirement: One-time local-to-S3 migration
The system SHALL provide a migration command that copies every object from
the local uploads volume into the configured S3 bucket exactly once
(skipping objects already present), without modifying the database.

#### Scenario: Migration is idempotent
- **WHEN** the migration command runs twice
- **THEN** the second run skips all already-migrated objects

### Requirement: Map package export and import work with any driver
The map package export and import flows SHALL read and write their floor
images, fog masks and referenced assets through the active storage driver,
so packages build and apply identically under the local and S3 drivers.

#### Scenario: Export reads from S3
- **WHEN** a map is exported while the S3 driver is active
- **THEN** the package contains the floor images, fog masks and referenced
  assets fetched from storage
