# Architecture Notes — Simple VTT

How the codebase fits together, for contributors (and the AI agents that
help them). User-facing guides: [`ADMIN_GUIDE.md`](ADMIN_GUIDE.md) ·
[`PLAYER_GUIDE.md`](PLAYER_GUIDE.md) · [`DEPLOY.md`](../DEPLOY.md).

## Layout

```
frontend/               Vite + TypeScript, no framework
  src/
    api/                REST client + WebSocket singleton
    canvas/             Stateless painters (map, grid, tokens, fog, portals)
      camera.ts         Pure math: screen ↔ world, zoom anchoring
      los.ts            Line-of-sight geometry & wall parsing
      tiles.ts          Tile-pyramid renderer (heavy maps)
    pages/              One module per route (login, lobby, map)
backend/                Express + ws + better-sqlite3
  src/
    routes/             REST endpoints (tables, tokens, portals, assets…)
    hub.ts              WebSocket rooms + server-authoritative state pushes
    db.ts               Schema + idempotent migrations (runs on import)
    tiles.ts            Tile pyramid generation (sharp)
uploads/                Map images + per-floor tile pyramids
```

## Builds

```bash
cd frontend && npm run build   # tsc + vite → ../backend/public (hashed assets)
cd backend  && npm run build   # tsc → dist/
```

The backend serves `backend/public` (built frontend) with the SPA fallback;
there is no separate static host. `npm run dev` (vite, port 5173) proxies
`/api`, `/ws` and `/uploads` to a backend on `:8080`.

## Coordinates & rendering

- World space = map pixels at zoom 1. Tokens, fog points, portals and walls
  are stored in world units; the camera converts to screen pixels.
- Three stacked canvases: main (map + grid + tokens), fog (fog-of-war
  overlay, `pointer-events: none`), UI (measurements).
- Fog composites in three phases — greyscale explored memory, transparent
  holes for current sight (LOS polygons), dark fill for never-explored
  space. The explored mask is stamped only when sight actually changes
  (dirty flag), never per frame.

## Tile pyramids (heavy maps)

A decoded map bitmap costs `width × height × 4` bytes of browser RAM —
resolution-driven, regardless of file compression. An 8000×6000 map decodes
to ~190 MB and used to crash phones. Large maps are therefore served as
tile pyramids instead of one bitmap:

- **Generation** (`backend/src/tiles.ts`, sharp): on import and image
  replace, each floor gets `uploads/tiles/<floorId>/<z>/<x>_<y>.jpg` —
  256 px JPEG tiles, `z=0` a single overview, each level doubling
  resolution (≤ 8 levels). Built asynchronously into a temp dir, then moved
  into place atomically; a failed build never blocks the import (the floor
  keeps its full image).
- **Legacy floors** self-migrate: the first client to view a floor without
  a pyramid triggers a background build (`hub.ts`, deduplicated in-flight);
  the fresh `table_state` push switches every client to tiles.
- **Rendering** (`frontend/src/canvas/tiles.ts`): only viewport tiles are
  fetched, held in a 100-tile LRU (~26 MB) of `ImageBitmap`s, closed
  deterministically on eviction. The working level follows the camera
  zoom; a one-tile prefetch ring smooths panning.
- **Memory model on tiled floors**: the full-resolution bitmap is never
  requested. The fog's greyscale phase uses the 256 px overview tile; the
  explored mask runs at quarter scale (it is a binary mask — the
  1/8-scale masks stashed for inactive floors already proved the
  resolution is irrelevant).
- **Fallbacks**: missing tiles are cached as failures (the SPA can return
  HTML for absent files — the client checks the blob type); an unusable
  pyramid (deleted on disk…) drops that session back to the legacy full
  image.
- **Cost**: pyramids add ~1.3× the map size on disk (JPEG, one-time per
  floor). The original image stays for the fallback path and exports.

Net effect: map-view RAM is bounded by the viewport instead of scaling
with the map resolution.

## State & synchronisation

- The server is authoritative. Mutations flow through the WebSocket
  (`token_move`, `fog_update`, `portal_toggle`, …); every connected client
  receives broadcasts, and `table_state` pushes resync joiners and floor
  switchers.
- Tokens, portals and fog points are floor-scoped: clients only ever
  receive the active floor's rows.
- The map page is optimistic — local state updates immediately, the
  server confirms via broadcast, and REST failures fall back to resync.

## Database

SQLite (`better-sqlite3`, WAL). `src/db.ts` runs every start: `CREATE
TABLE IF NOT EXISTS` for the schema plus idempotent migration blocks
(add-column guards, marker rows in `settings`). **New columns must be
added with a `PRAGMA table_info` guard**, never by editing the CREATE
statements — existing installs rely on the migrations.

`floors.tiles_path` (empty string = no pyramid yet) is the tile system's
only schema addition.

## Conventions

- Canvas painters stay stateless — all state lives in the map page's
  `GameState`; shared caches (token images, map images, tiles) are
  module-level with explicit reset/eviction paths.
- Background work (pyramid builds) logs `[tiles] …` on failure and never
  breaks the request that triggered it.
- Static responses carry long-lived immutable caching (`/uploads`, hashed
  frontend assets); `index.html` stays `no-cache` so new builds ship.
