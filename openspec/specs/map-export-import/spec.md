# map-export-import Specification

## Purpose

Enable portability of single maps (with all floors, entities, fog-of-war
masks and their referenced shared images) and of the shared asset library,
via downloadable ZIP packages that can be re-imported on the same or another
Simple VTT instance.

## Requirements

### Requirement: Map package export
The system SHALL allow the DM of a map to export it as a ZIP package
containing a manifest, every floor's map image, every floor's fog-of-war
mask, all entities (tokens, portals, walls, props, stairs), memberships, and
every shared-library image the map references (keyed by content hash).

#### Scenario: DM exports a multi-floor map
- **WHEN** the DM requests the export of a map with floors, tokens, portals,
  walls, props and stairs
- **THEN** the server streams a ZIP containing the manifest, one image per
  floor, one fog mask per floor with a mask, and the referenced shared assets
- **AND** the response has a `Content-Disposition` attachment filename

#### Scenario: Export is DM-only
- **WHEN** a user who is not a DM of the map requests the export
- **THEN** the server responds with an authorization error

### Requirement: Map package import
The system SHALL allow any authenticated user to import a map package as a
new table: fresh entity ids are generated through an old-to-new floor id
mapping, fog masks are written under the new floor ids, referenced assets
are re-registered into the shared library with content-hash deduplication
(existing hashes reuse stored files), the importer becomes the map's DM and
owner, and imported memberships are applied only for usernames that exist
locally.

#### Scenario: Import preserves token placement
- **WHEN** a map package containing a token at specific coordinates is
  imported
- **THEN** the imported map has a token with the same name, coordinates
  (x, y), size, color and floor assignment

#### Scenario: Import creates a fresh independent copy
- **WHEN** a map package is imported
- **THEN** the new table has newly generated ids for the table, floors and
  entities, so importing the same package twice yields two independent maps

### Requirement: Shared-library deduplication on import
The system SHALL deduplicate referenced assets by content hash when applying
a map package: an asset whose hash already exists in the shared library
reuses the stored file, and only new hashes are written and registered.

#### Scenario: Importing a package whose assets already exist
- **WHEN** a map package referencing assets that already exist (by hash) is
  imported
- **THEN** no duplicate files are stored and the import reports the reused
  assets

### Requirement: Asset library package export and import
The system SHALL allow an admin to export the shared asset library (entirely
or folder-by-folder) as a ZIP package with a content-hash manifest, and to
import such a package with content-hash deduplication, reporting the number
of assets added and skipped.

#### Scenario: Admin exports a folder
- **WHEN** an admin exports a specific asset folder
- **THEN** the server streams a ZIP containing exactly the assets of that
  folder with a manifest listing kind, name, folder and content hash

#### Scenario: Importing an asset package twice is harmless
- **WHEN** an asset package is imported twice
- **THEN** the second import skips all assets already present (by hash) and
  reports them as skipped

