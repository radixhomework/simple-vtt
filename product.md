# Product — Simple VTT

**Simple VTT** is a simple, lightweight, self-hosted virtual tabletop for
pen-and-paper role-playing games. One person hosts the app (Docker, a
small server, a NAS); the Dungeon Master prepares maps and runs sessions;
players connect from any modern browser — desktop or tablet, including
Apple Pencil support. There is no account system beyond the instance's
own users, no telemetry, no cloud dependency (except the optional S3 blob
storage the host chooses).

## Who uses it

- **The host / admin** — deploys and runs the instance (typically Docker),
  manages users, assets and settings in the admin console.
- **The DM (map master)** — imports maps, prepares floors, fog, tokens,
  doors and walls, runs the session live.
- **Players** — join a map via their account, move their tokens, see what
  their token sees, use chat, music transport and measurements.

## Core capabilities

- **Maps & floors** — import from Universal VTT (`.uvtt` / Dungeondraft
  zip, with the Simple VTT props extension) or upload images; multiple
  floors per map with stairs; per-map access control (members, DM vs
  player); grid + offsets editable per floor.
- **Fog of war** — server-persisted raster reveal masks per floor, a live
  fog brush (continuous along the cursor path, no grid snapping, size
  slider), Reset Fog (arrival state) vs Clear Fog (remove all, persisted),
  player vision from tokens with LOS against walls.
- **Tokens** — images/sizes/colors, vision radius, owners, hidden tokens
  (DM-only), cross-floor moves via stairs, players-move-own-only setting.
- **Doors & windows (portals)** — click to open/close, permissions
  controlled per map.
- **Walls** — hand-drawn or imported from UVTT line-of-sight; grouped
  build-mode walls; block sight and/or movement.
- **Props** — decorative scenery from the UVTT props extension, or placed
  from the shared asset library.
- **Asset library** — shared images and audio with folders; music queue
  with server-authoritative transport.
- **Realtime** — everything syncs over one WebSocket per client; the
  server is authoritative; joiners resync via `table_state`.
- **Backup & restore** — one-click whole-instance backup ZIP (database +
  blobs on the local driver, database-only on S3); restore through the
  first-start setup wizard on a fresh deployment.
- **First-start setup wizard** — a fresh instance asks to create the
  first admin (or adopt the environment bootstrap admin) or to import a
  backup; closed permanently once setup completes.

## Blob storage

Blobs (map images, assets, fog masks, tile pyramids) live behind a
storage abstraction: the **local** filesystem driver (default, under
`UPLOADS_DIR` on the data volume) or any **S3-compatible** endpoint
(`STORAGE_DRIVER=s3`). Blob keys are the database's URL paths minus the
`/uploads/` prefix — the database never changes format. A migration CLI
copies local blobs to the bucket; a cleanup CLI reclaims the local copies
after verification. The container refuses to start on invalid storage
configuration.

## Non-goals

- No multi-instance scaling (one container, one SQLite database).
- No hosted/cloud service, accounts, or billing.
- No 3D, video, or character-sheet integrations.
