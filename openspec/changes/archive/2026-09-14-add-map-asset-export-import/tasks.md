# Tasks: add-map-asset-export-import

- [x] Model: buildMapPackage (manifest + floors + masks + referenced assets)
- [x] Model: applyMapPackage (fresh ids, floor mapping, asset dedup)
- [x] Routes: GET /tables/:id/export (dm-only), POST /tables/import-package
- [x] Routes: GET /assets/export (all or ?folder=), POST /assets/import-package
- [x] UI: Export button per map row, import drop zone on Maps & Tables
- [x] UI: Export all / Import assets / per-folder export on Assets page
- [x] Regression test: export → import preserves token placement
