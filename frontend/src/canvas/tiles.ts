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

/** Upper bound on tiles warmed per adjacent level. Beyond this the warm
 *  is skipped (far zoom-out): fetching more than the LRU can hold would
 *  churn evict/refetch cycles for tiles the user may never need. */
const MAX_WARM_TILES = 40

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

/** Failure cooldown by URL, independent of the LRU: an evicted entry's
 *  cooldown must survive eviction, otherwise a failed tile gets evicted,
 *  re-encountered, and re-fetched forever (failure→repaint→refetch loop). */
const failedUntil = new Map<string, number>()

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
    // NOTE: do not clear `inflight` here while fetches are running —
    // orphaned promises would re-issue the same URLs as duplicates.
    // loadTile's in-flight map self-cleans as each fetch finishes.
    // Also clear per-URL failure cooldowns so a fresh floor starts clean.
    failedUntil.clear()
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
/** Base minimum zoom travel (log2 units) between two level switches. */
const SWITCH_SETTLE = 0.35
/** Rapid switching escalates the settle threshold ×2 per flip (capped),
 *  so a sustained oscillation locks itself out after a few switches no
 *  matter its amplitude — "indefinite flip-flopping" is impossible.
 *  Decays back after SWITCH_QUIET_MS without any switch. */
const SWITCH_QUIET_MS = 2000
const SETTLE_CAP = 2.8 // ≈ ×7 zoom travel between switches worst case

/** Zoom (in level-boundary units t) at the last level switch. */
let lastSwitchT = -Infinity
/** Wall-clock time of the last switch (escalation bookkeeping). */
let lastSwitchAt = 0
/** Current settle threshold (log2 units). */
let settle = SWITCH_SETTLE

/** Total level switches since load (diagnostics). */
let levelSwitches = 0

function levelForZoom(cam: Camera, levels: number, prevZ?: number): number {
  const t = Math.log2(cam.zoom) + levels - 1
  const ideal = Math.max(0, Math.min(levels - 1, Math.ceil(t)))
  if (prevZ === undefined || prevZ < 0 || prevZ === ideal) return ideal

  // Escalation decay: after a quiet period the threshold resets
  const now = performance.now()
  if (now - lastSwitchAt > SWITCH_QUIET_MS) settle = SWITCH_SETTLE

  const settled = Math.abs(t - lastSwitchT) > settle
  if (ideal > prevZ) {
    // zooming in: switch up only clearly past the boundary, and only once
    // the zoom has genuinely travelled since the last switch
    if (t > prevZ + LEVEL_HYST && settled) {
      lastSwitchT = t
      lastSwitchAt = now
      settle = Math.min(settle * 2, SETTLE_CAP)
      levelSwitches++
      return ideal
    }
    return prevZ
  }
  // zooming out: keep the finer level a bit past the boundary
  if (t < prevZ - 1 + (1 - LEVEL_HYST) && settled) {
    lastSwitchT = t
    lastSwitchAt = now
    settle = Math.min(settle * 2, SETTLE_CAP)
    levelSwitches++
    return ideal
  }
  return prevZ
}

/** Hook set by the renderer so a finished tile triggers a repaint. */
let onTileLoaded: (() => void) | null = null

/** Start (or reuse) the fetch for one tile URL. */
function fetchTile(base: string, ck: string, k: TileKey, entry: TileEntry): void {
  const existing = inflight.get(ck)
  if (existing) return   // already being fetched — never double-fetch
  if (flights() >= MAX_CONCURRENT_FETCHES) {
    // Queue is full: start nothing. The entry stays bitmap-less and
    // unpending; the retry pump in drawTiledMap schedules the next frame.
    deferredByCap++
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
    .then(bmp => { entry.bitmap = bmp; failedUntil.delete(ck) })
    .catch(() => { entry.failed = true; entry.failedAt = performance.now(); failedUntil.set(ck, performance.now() + RETRY_MS) })
    .finally(() => {
      entry.pending = false
      inflight.delete(ck)
      onTileLoaded?.()
    })
  inflight.set(ck, p)
}

/** Load (or reuse) one tile. Missing tiles start an async fetch; failures
 *  are remembered per-URL with a cooldown that survives LRU eviction. */
function loadTile(base: string, k: TileKey): TileEntry {
  const ck = key(k)
  const hit = cache.get(ck)
  if (hit) {
    if (hit.bitmap !== null || hit.pending) return hit
  }
  // Failure cooldown (checked before any re-insert): recent failures are
  // served as cached entries when they exist, or nothing when evicted —
  // either way no request goes out.
  const cooldown = failedUntil.get(ck)
  if (cooldown !== undefined && performance.now() < cooldown) {
    if (hit) return hit
    const cooled: TileEntry = { bitmap: null, failed: true, failedAt: cooldown - RETRY_MS, pending: false }
    cache.set(ck, cooled)
    return cooled
  }
  const entry: TileEntry = hit ?? { bitmap: null, failed: false, failedAt: 0, pending: false }
  cache.set(ck, entry)
  fetchTile(base, ck, k, entry)
  return entry
}

/** Immutable per-draw geometry shared by the cascade (cuts the parameter
 *  list down to something readable). */
interface TileView {
  ctx: CanvasRenderingContext2D
  base: string
  cam: Camera
  mapW: number
  mapH: number
  mapOffsetX: number
  mapOffsetY: number
  levels: number
  overview: ImageBitmap | null
}

/** Visible-rect + pyramid-bound bundle for the prefetch helpers. */
interface ViewportRanges {
  x0: number; y0: number; x1: number; y1: number
  maxTx: number; maxTy: number
  worldL: number; worldT: number; worldR: number; worldB: number
}

/**
 * Draw one tile, cascading to ancestors when it is not loaded yet.
 *
 * A missing tile at (z, x, y) is covered by the corresponding region of
 * its parent tile (z-1, x>>1, y>>1) — blurrier, but the map never
 * blanks. Edge tiles have truncated cells; the crop is computed in
 * world-space fractions so both the child extent and the parent crop are
 * correct even on truncated pyramids. The cascade bottoms out at the z0
 * overview bitmap (carried by the view), so the viewport always has
 * coverage; level transitions during zoom become a brief blur instead of
 * a black flash.
 *
 * Returns true when something was drawn (tile, an ancestor, or overview).
 */
function drawTileCascaded(
  v: TileView,
  k: TileKey,
  wx: number,           // world-space rect of this tile's cell
  wy: number,
  ww: number,
  wh: number,
): boolean {
  const { ctx, base, cam } = v
  const sx = (wx - cam.x) * cam.zoom
  const sy = (wy - cam.y) * cam.zoom
  const dw = ww * cam.zoom
  const dh = wh * cam.zoom

  const entry = cache.get(key(k))
  if (entry?.bitmap) {
    ctx.drawImage(entry.bitmap, sx, sy, dw, dh)
    return true
  }

  // Not loaded (pending/failed/evicted): request it…
  loadTile(base, k)

  // …and cover with the parent's matching region
  if (k.z > 0) {
    const pz = k.z - 1
    const pScale = Math.pow(2, pz + 1 - v.levels)
    const pTileWorld = TILE_SIZE / pScale
    const px = k.x >> 1
    const py = k.y >> 1
    const parent = cache.get(key({ z: pz, x: px, y: py }))
    if (parent?.bitmap) {
      // Parent cell (world space, truncated at the map edge)
      const pWx = v.mapOffsetX + px * pTileWorld
      const pWy = v.mapOffsetY + py * pTileWorld
      const pWw = Math.min(pTileWorld, v.mapW - px * pTileWorld)
      const pWh = Math.min(pTileWorld, v.mapH - py * pTileWorld)
      // Crop the fraction of the parent that this child covers. Using
      // fractions of the world rect keeps the math exact for truncated
      // cells on either level.
      const f0x = (wx - pWx) / pWw
      const f0y = (wy - pWy) / pWh
      const f1x = (wx + ww - pWx) / pWw
      const f1y = (wy + wh - pWy) / pWh
      ctx.drawImage(
        parent.bitmap,
        f0x * parent.bitmap.width, f0y * parent.bitmap.height,
        (f1x - f0x) * parent.bitmap.width, (f1y - f0y) * parent.bitmap.height,
        sx, sy, dw, dh,
      )
      return true
    }
    // Parent not cached either — request it so the cascade materializes
    loadTile(base, { z: pz, x: px, y: py })
  }

  // Last resort: the z0 overview bitmap covers everything
  const overview = v.overview
  if (overview && k.z !== 0) {
    const f0x = (wx - v.mapOffsetX) / v.mapW
    const f0y = (wy - v.mapOffsetY) / v.mapH
    const f1x = (wx + ww - v.mapOffsetX) / v.mapW
    const f1y = (wy + wh - v.mapOffsetY) / v.mapH
    ctx.drawImage(
      overview,
      f0x * overview.width, f0y * overview.height,
      (f1x - f0x) * overview.width, (f1y - f0y) * overview.height,
      sx, sy, dw, dh,
    )
    return true
  }
  return false
}

/**
 * Draw the map for the viewport covered by cam from the pyramid at `base`.
 * Returns true when anything was drawn (caller may skip its legacy path).
 * Missing tiles are covered by their coarser ancestors (cascade) and
 * requested asynchronously; each arrival triggers one repaint via `repaint`.
 * `overview` is the z0 overview bitmap used as the never-missing floor of
 * the cascade (the fog renderer already loads it).
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
  overview?: ImageBitmap | null,
): boolean {
  const levels = pyramidLevels(mapW, mapH)
  if (levels === 0) return false
  onTileLoaded = repaint
  const z = levelForZoom(cam, levels, currentLevel)
  currentLevel = z
  const view: TileView = { ctx, base, cam, mapW, mapH, mapOffsetX, mapOffsetY, levels, overview: overview ?? null }
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
  const ranges: ViewportRanges = { x0, y0, x1, y1, maxTx, maxTy, worldL, worldT, worldR, worldB }

  let drewAny = false
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      // World-space cell of this tile (truncated at the map edge)
      const wx = mapOffsetX + tx * tileWorld
      const wy = mapOffsetY + ty * tileWorld
      const ww = Math.min(tileWorld, mapW - tx * tileWorld)
      const wh = Math.min(tileWorld, mapH - ty * tileWorld)
      if (drawTileCascaded(view, { z, x: tx, y: ty }, wx, wy, ww, wh)) {
        drewAny = true
      }
    }
  }

  prefetchRing(view, z, ranges)
  warmAdjacentLevels(view, z, ranges)

  // Retry pump: when the concurrency cap deferred wanted tiles (they were
  // requested by loadTile but no fetch started — no completion event will
  // fire), keep painting frames until the queue drains. Without this, the
  // single-shot render loop would never pick them up.
  if (deferredByCap > 0) {
    deferredByCap = 0
    requestAnimationFrame(() => onTileLoaded?.())
  }
  return drewAny
}

/** Prefetch ring: one tile beyond the viewport on each side, so panning
 *  doesn't hit blank areas. Clamped to the pyramid bounds — out-of-range
 *  tiles can never exist and would only burn failed requests. */
function prefetchRing(v: TileView, z: number, r: ViewportRanges): void {
  for (let ty = Math.max(0, r.y0 - 1); ty <= Math.min(r.maxTy, r.y1 + 1); ty++) {
    for (let tx = Math.max(0, r.x0 - 1); tx <= Math.min(r.maxTx, r.x1 + 1); tx++) {
      if (tx >= r.x0 && tx <= r.x1 && ty >= r.y0 && ty <= r.y1) continue
      loadTile(v.base, { z, x: tx, y: ty })
    }
  }
}

/** Adjacent-level warming: prefetch the viewport's tiles at z+1 and z-1
 *  so a slow zoom in either direction finds them already cached. Bounded
 *  by MAX_WARM_TILES per level: at far zoom-out an adjacent level's
 *  viewport can span hundreds of tiles — warming it would thrash the LRU
 *  (evict/refetch churn) for tiles the user may never zoom to. The
 *  ancestor cascade already covers those transitions gracefully. */
function warmAdjacentLevels(v: TileView, z: number, r: ViewportRanges): void {
  for (const wz of [z + 1, z - 1]) {
    if (wz < 0 || wz > v.levels - 1) continue
    const wScale = Math.pow(2, wz + 1 - v.levels)
    const wTileWorld = TILE_SIZE / wScale
    const wMaxTx = tilesPerAxis(v.mapW, v.levels, wz) - 1
    const wMaxTy = tilesPerAxis(v.mapH, v.levels, wz) - 1
    const wx0 = Math.max(0, Math.floor((r.worldL - v.mapOffsetX) / wTileWorld))
    const wy0 = Math.max(0, Math.floor((r.worldT - v.mapOffsetY) / wTileWorld))
    const wx1 = Math.min(wMaxTx, Math.floor((r.worldR - v.mapOffsetX) / wTileWorld))
    const wy1 = Math.min(wMaxTy, Math.floor((r.worldB - v.mapOffsetY) / wTileWorld))
    const wCount = (wx1 - wx0 + 1) * (wy1 - wy0 + 1)
    if (wCount > MAX_WARM_TILES) continue
    for (let ty = wy0; ty <= wy1; ty++) {
      for (let tx = wx0; tx <= wx1; tx++) {
        loadTile(v.base, { z: wz, x: tx, y: ty })
      }
    }
  }
}

/** Tiles wanted but not started due to the concurrency cap this frame. */
let deferredByCap = 0

/** Level chosen by the last drawTiledMap call (hysteresis state). */
let currentLevel = -1

/** Drop every cached tile (floor switch / teardown). */
export function resetTileCache(): void {
  cache.clear()
  currentLevel = -1
  lastSwitchT = -Infinity
  lastSwitchAt = 0
  settle = SWITCH_SETTLE
  levelSwitches = 0
}

/** Diagnostics: level switches and last chosen level (test hook). */
export function tileDiagnostics(): { levelSwitches: number; currentLevel: number } {
  return { levelSwitches, currentLevel }
}
