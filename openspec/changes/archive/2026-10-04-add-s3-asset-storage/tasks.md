# Tasks: add-s3-asset-storage

## 1. Storage abstraction

- [x] 1.1 `backend/src/storage/index.ts`: driver interface (`put`, `get`,
      `getStream`, `delete`, `exists`) + driver selection from
      `STORAGE_DRIVER` (default `local`)
- [x] 1.2 `LocalStorageDriver`: fs implementation under `UPLOADS_DIR`
      (current behavior, byte-identical)
- [x] 1.3 `S3StorageDriver`: `@aws-sdk/client-s3` implementation
      (GetObject/ PutObject/ DeleteObject/ HeadObject; GetObject body
      returned as stream)

## 2. Call-site migration

- [x] 2.1 Serving route `/uploads/:key` → `getStream` +
      `Cache-Control: immutable`
- [x] 2.2 Asset upload/delete, floor image upload, fog-mask write,
      tile build/delete, map-package apply/export → storage calls

## 3. Migration & config

- [x] 3.1 `migrate-to-s3` CLI command (walk local dir, skip existing
      objects, summary log)
- [x] 3.2 `.env` documentation: `STORAGE_DRIVER`, `S3_ENDPOINT`,
      `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`

## 4. Verification

- [x] 4.1 Test: local driver byte-identical to pre-change behavior
- [x] 4.2 **Won't do** (accepted by the user, 2026-10-04): live MinIO test —
      upload, serve, delete, migration idempotency. Not run: this environment
      cannot pull container images. The S3 code paths were instead verified
      through the real @aws-sdk/client-s3 against an S3 stub (upload, serve,
      delete, idempotent copy) plus fail-fast startup validation; residual
      risk (auth/bucket semantics) accepted, re-check at deploy time.
- [x] 4.3 Regression: existing suite (export/import roundtrip, fog masks)
      green under both drivers
