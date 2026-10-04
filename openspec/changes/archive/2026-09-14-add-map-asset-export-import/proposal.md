# Proposal: add-map-asset-export-import

## Why

Maps and asset collections were locked inside a single server instance.
Sharing a single dungeon (with floors, tokens, fog-of-war state and images)
or moving an asset folder between instances required host-level file access.

## What changes

- Map packages: DM-only export of a map as a ZIP (manifest, floor images,
  fog masks, entities, memberships, referenced shared assets keyed by
  content hash); import by any authenticated user creating a fresh,
  independent table with the importer as DM.
- Asset packages: admin export of the whole library or folder-by-folder,
  and import with content-hash deduplication.

## Non-goals

- Full-instance backup (users, settings) — possible future change.
- Merging diverged map state — import is always additive (new table).

## Capabilities

- `map-export-import` (new spec, delta in this change)

## Tasks

- [x] Model layer: buildMapPackage / applyMapPackage with typed raw rows
- [x] Routes: GET /tables/:id/export (dm-only), POST /tables/import-package
- [x] Asset package export (all / folder) and import with dedup
- [x] UI: Export / Import map package on Maps & Tables; Export all /
      Import assets / per-folder export on Assets page
- [x] Regression test: export → import preserves token placement
