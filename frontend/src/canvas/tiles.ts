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
 */
import type { Camera } from '../types'

export const TILE_SIZE = 256
export const MAX_ZOOM_LEVELS = 8

/** Tiles held decoded at once — 100 × 256×256×4 ≈ 26 MB worst case. */
const MAX_TILES = 100

export interface TileKey { z: number; x: number; y: number }

interface TileEntry {
  bitmap: ImageBitmap | null   // null while loading, or after a failed load
  failed: boolean
}

const key = (k: TileKey) => `${k.z}/${k.x}/${k.y}`

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
    while (this.map.size > MAX_TILES) {
      const oldest = this.map.keys().next().value as string
      const entry = this.map.get(oldest)
      entry?.bitmap?.close()   // deterministic free of the decoded pixels
      this.map.delete(oldest)
    }
  }
  clear() {
    for (const v of this.map.values()) v.bitmap?.close()
    this.map.clear()
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

/**
 * Level whose scale is closest to the camera's zoom without going below
 * half the native density (i.e. never blurrier than necessary, and stop at
 * the finest available level).
 */
function levelForZoom(cam: Camera, levels: number): number {
  // screen px per world px = cam.zoom. Level z renders the map at scale
  // 2^(z - levels + 1) relative to native. We want that ≥ cam.zoom.
  const need = Math.ceil(Math.log2(cam.zoom) + levels - 1)
  return Math.max(0, Math.min(levels - 1, need))
}

/** Load (or reuse) one tile. Returns null on failure (cached as failed). */
function loadTile(base: string, k: TileKey): TileEntry {
  const ck = key(k)
  const hit = cache.get(ck)
  if (hit) return hit
  const entry: TileEntry = { bitmap: null, failed: false }
  cache.set(ck, entry)
  fetch(`${base}/${k.z}/${k.x}_${k.y}.jpg`)
    .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.blob() })
    .then(b => {
      // A missing file can come back as 200 SPA HTML (server fallback) —
      // only accept actual images
      if (!b.type.startsWith('image/')) throw new Error('not an image')
      return createImageBitmap(b)
    })
    .then(bmp => { entry.bitmap = bmp; onTileLoaded?.() })
    .catch(() => { entry.failed = true; onTileLoaded?.() })
  return entry
}

/** Hook set by the renderer so a finished tile triggers a repaint. */
let onTileLoaded: (() => void) | null = null

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

  const z = levelForZoom(cam, levels)
  // World-space size of one tile at this level: the level image is
  // 2^(z+1-levels) × native, so one tile covers TILE_SIZE / scale world px.
  const scale = Math.pow(2, z + 1 - levels)
  const tileWorld = TILE_SIZE / scale

  // Visible world rect
  const worldL = cam.x
  const worldT = cam.y
  const worldR = cam.x + ctx.canvas.width / cam.zoom
  const worldB = cam.y + ctx.canvas.height / cam.zoom

  const x0 = Math.max(0, Math.floor((worldL - mapOffsetX) / tileWorld))
  const y0 = Math.max(0, Math.floor((worldT - mapOffsetY) / tileWorld))
  const x1 = Math.min(Math.ceil((mapW * scale / TILE_SIZE)) - 1, Math.floor((worldR - mapOffsetX) / tileWorld))
  const y1 = Math.min(Math.ceil((mapH * scale / TILE_SIZE)) - 1, Math.floor((worldB - mapOffsetY) / tileWorld))

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
  // doesn't hit blank areas
  for (let ty = y0 - 1; ty <= y1 + 1; ty++) {
    for (let tx = x0 - 1; tx <= x1 + 1; tx++) {
      if (tx >= x0 && tx <= x1 && ty >= y0 && ty <= y1) continue
      if (tx < 0 || ty < 0) continue
      if (tx > x1 + 1 || ty > y1 + 1) continue
      loadTile(base, { z, x: tx, y: ty })
    }
  }
  return drewAny
}

/** Drop every cached tile (floor switch / teardown). */
export function resetTileCache(): void {
  cache.clear()
}
