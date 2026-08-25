/**
 * Tile-pyramid map renderer.
 *
 * Instead of decoding the full-resolution map (width × height × 4 bytes of
 * RAM — an 8000×6000 map is ~190 MB decoded), draw the map from 256×256
 * JPEG tiles. Only the tiles covering the current viewport are fetched and
 * cached (LRU, capped), so memory stays bounded no matter how large the
 * map is.
 *
 * Server layout: <tiles_path>/<z>/<x>_<y>.jpg with z=0 the coarsest level
 * (one tile) and each level doubling the resolution. This module computes
 * the same level count from the map's native dimensions.
 *
 * Robustness rules (learned the hard way — see the fetch-storm fix):
 *   - one fetch per tile URL at any moment, even across evictions
 *   - entries with a pending fetch are never LRU-evicted
 *   - at most MAX_CONCURRENT_FETCHES tile requests in flight
 *   - zoom-level changes have hysteresis (no level flapping on pinch)
 *   - tiles outside the pyramid are never requested
 *   - failed tiles retry at most once per RETRY_MS
 */
import type { Camera } from '../types'

export const TILE_SIZE = 256
export const MAX_ZOOM_LEVELS = 8

/** Tiles held decoded at once — 100 × 256×256×4 ≈ 26 MB worst case. */
const MAX_TILES = 100

/** Concurrent tile fetches allowed. Everything above waits for the next
 *  frame — a hard ceiling so the browser's request queue can never
 *  saturate (ERR_INSUFFICIENT_RESOURCES). */
const MAX_CONCURRENT_FETCHES = 24

/** A failed tile is not retried for this long (transient server hiccups,
 *  pyramid rebuilds) — stops failure→repaint→refetch cycles. */
const RETRY_MS = 30_000

export interface TileKey { z: number; x: number; y: number }

interface TileEntry {
  bitmap: ImageBitmap | null   // null while loading, or after a failed load
  failed: boolean
  failedAt: number             // 0 = never failed / not applicable
  pending: boolean             // fetch in flight
}

const key = (k: TileKey) => `${k.z}/${k.x}/${k.y}`

/** Live fetches by URL — an evicted tile whose fetch is still running
 *  reuses the promise instead of issuing a second request. */
const inflight = new Map<string, Promise<void>>()

function flights(): number { return inflight.size }

class TileCache {
  private map = new Map<string, TileEntry>()
  /** Access order for LRU eviction (Map preserves insertion order). */
  touch(k: string) {
    const v = this.map.get(k)
    if (v) { this.map.delete(k); this.map.set(k, v) }
  }
  get(k: string): TileEntry | undefined {
    this.touch(k)
    return this.map.get(k)
  }
  set(k: string, v: TileEntry) {
    if (this.map.has(k)) this.touch(k)
    else {
      this.map.set(k, v)
      this.evict()
    }
  }
  private evict() {
    if (this.map.size <= MAX_TILES) return
    // Evict the oldest entry that is safe to drop: never one with a
    // pending fetch (its result would leak and the tile would refetch).
    for (const k of this.map.keys()) {
      if (this.map.size <= MAX_TILES) break
      const entry = this.map.get(k)
      if (entry?.pending) continue
      entry?.bitmap?.close()   // deterministic free of the decoded pixels
      this.map.delete(k)
    }
  }
  clear() {
    for (const v of this.map.values()) v.bitmap?.close()
    this.map.clear()
    inflight.clear()
  }
}

const cache = new TileCache()

/** Pyramid level count for a map of native size w×h (mirrors the server). */
export function pyramidLevels(w: number, h: number): number {
  if (w <= 0 || h <= 0) return 0
  return Math.min(
    MAX_ZOOM_LEVELS,
    Math.max(1, Math.ceil(Math.log2(Math.max(w, h) / TILE_SIZE)) + 1),
  )
}

/** Tile count along each axis at level z (mirrors the server layout). */
function tilesPerAxis(mapPx: number, levels: number, z: number): number {
  const scale = Math.pow(2, z + 1 - levels)
  return Math.ceil((mapPx * scale) / TILE_SIZE)
}

/**
 * Level whose scale is closest to the camera's zoom without going below
 * half the native density. `prevZ` adds hysteresis: zoom boundaries are
 * integers of t = log2(zoom) + levels − 1, and a level change requires
 * crossing the boundary by LEVEL_HYST — pinch gestures emit ~60 events/s
 * and without this the level (and its whole tile set) would flip-flop on
 * every step.
 */
const LEVEL_HYST = 0.25 // log2 units of zoom past a boundary before switching
function levelForZoom(cam: Camera, levels: number, prevZ?: number): number {
  const t = Math.log2(cam.zoom) + levels - 1
  const ideal = Math.max(0, Math.min(levels - 1, Math.ceil(t)))
  if (prevZ === undefined || prevZ < 0 || prevZ === ideal) return ideal
  if (ideal > prevZ) {
    // zooming in: switch up only clearly past the boundary
    return t > prevZ + LEVEL_HYST ? ideal : prevZ
  }
  // zooming out: keep the finer level a bit past the boundary
  return t < prevZ - 1 + (1 - LEVEL_HYST) ? ideal : prevZ
}

/** Hook set by the renderer so a finished tile triggers a repaint. */
let onTileLoaded: (() => void) | null = null

/** Start (or reuse) the fetch for one tile URL. */
function fetchTile(base: string, ck: string, k: TileKey, entry: TileEntry): void {
  const existing = inflight.get(ck)
  if (existing) return   // already being fetched — never double-fetch
  if (flights() >= MAX_CONCURRENT_FETCHES) {
    // Queue is full: start nothing. The entry stays bitmap-less and
    // unpending; the next frame calls fetchTile again until a slot
    // frees up. (Never set pending without a live fetch — the entry
    // would be stuck protected-but-never-loading.)
    return
  }
  entry.pending = true
  const p = fetch(`${base}/${k.z}/${k.x}_${k.y}.jpg`)
    .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.blob() })
    .then(b => {
      // A missing file can come back as 200 SPA HTML (server fallback) —
      // only accept actual images
      if (!b.type.startsWith('image/')) throw new Error('not an image')
      return createImageBitmap(b)
    })
    .then(bmp => { entry.bitmap = bmp })
    .catch(() => { entry.failed = true; entry.failedAt = performance.now() })
    .finally(() => {
      entry.pending = false
      inflight.delete(ck)
      onTileLoaded?.()
    })
  inflight.set(ck, p)
}

/** Load (or reuse) one tile. Missing tiles start an async fetch; failures
 *  are cached with a cooldown. */
function loadTile(base: string, k: TileKey): TileEntry {
  const ck = key(k)
  const hit = cache.get(ck)
  if (hit) {
    // Failed recently? Serve the failure without refetching.
    if (hit.failed && performance.now() - hit.failedAt < RETRY_MS) return hit
    if (hit.bitmap !== null || hit.pending) return hit
    // failed long ago (or failed entry with expired cooldown): refetch below
    hit.failed = false
  }
  const entry: TileEntry = hit ?? { bitmap: null, failed: false, failedAt: 0, pending: false }
  cache.set(ck, entry)
  fetchTile(base, ck, k, entry)
  return entry
}

/**
 * Draw the map for the viewport covered by cam from the pyramid at `base`.
 * Returns true when anything was drawn (caller may skip its legacy path).
 * Missing tiles are left blank (canvas already cleared) and requested
 * asynchronously; each arrival triggers one repaint via `repaint`.
 */
export function drawTiledMap(
  ctx: CanvasRenderingContext2D,
  base: string,
  mapW: number,
  mapH: number,
  cam: Camera,
  mapOffsetX: number,
  mapOffsetY: number,
  repaint: () => void,
): boolean {
  const levels = pyramidLevels(mapW, mapH)
  if (levels === 0) return false
  onTileLoaded = repaint

  const z = levelForZoom(cam, levels, currentLevel)
  currentLevel = z
  // World-space size of one tile at this level: the level image is
  // 2^(z+1-levels) × native, so one tile covers TILE_SIZE / scale world px.
  const scale = Math.pow(2, z + 1 - levels)
  const tileWorld = TILE_SIZE / scale

  // Pyramid bounds at this level — nothing outside can exist on the server
  const maxTx = tilesPerAxis(mapW, levels, z) - 1
  const maxTy = tilesPerAxis(mapH, levels, z) - 1

  // Visible world rect
  const worldL = cam.x
  const worldT = cam.y
  const worldR = cam.x + ctx.canvas.width / cam.zoom
  const worldB = cam.y + ctx.canvas.height / cam.zoom

  const x0 = Math.max(0, Math.floor((worldL - mapOffsetX) / tileWorld))
  const y0 = Math.max(0, Math.floor((worldT - mapOffsetY) / tileWorld))
  const x1 = Math.min(maxTx, Math.floor((worldR - mapOffsetX) / tileWorld))
  const y1 = Math.min(maxTy, Math.floor((worldB - mapOffsetY) / tileWorld))

  let drewAny = false
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const entry = loadTile(base, { z, x: tx, y: ty })
      if (!entry.bitmap) continue
      // Screen rect of this tile. Edge tiles may be smaller than TILE_SIZE
      // (the server extracts only the map area), so keep their bitmap's
      // own aspect: dw/dh derive from the bitmap's pixel size, not TILE_SIZE.
      const wx = mapOffsetX + tx * tileWorld
      const wy = mapOffsetY + ty * tileWorld
      const sx = (wx - cam.x) * cam.zoom
      const sy = (wy - cam.y) * cam.zoom
      const dw = (entry.bitmap.width / scale) * cam.zoom
      const dh = (entry.bitmap.height / scale) * cam.zoom
      ctx.drawImage(entry.bitmap, sx, sy, dw, dh)
      drewAny = true
    }
  }

  // Prefetch ring: one tile beyond the viewport on each side, so panning
  // doesn't hit blank areas. Clamped to the pyramid bounds — out-of-range
  // tiles can never exist and would only burn failed requests.
  for (let ty = Math.max(0, y0 - 1); ty <= Math.min(maxTy, y1 + 1); ty++) {
    for (let tx = Math.max(0, x0 - 1); tx <= Math.min(maxTx, x1 + 1); tx++) {
      if (tx >= x0 && tx <= x1 && ty >= y0 && ty <= y1) continue
      loadTile(base, { z, x: tx, y: ty })
    }
  }
  return drewAny
}

/** Level chosen by the last drawTiledMap call (hysteresis state). */
let currentLevel = -1

/** Drop every cached tile (floor switch / teardown). */
export function resetTileCache(): void {
  cache.clear()
  currentLevel = -1
}
