/**
 * Tile pyramid generation for heavy maps.
 *
 * The full-resolution map bitmap is by far the largest RAM item in the
 * browser (width × height × 4 bytes — an 8000×6000 map decodes to ~190 MB
 * no matter how small its file is). Serving it tiled lets clients hold
 * only the tiles covering the viewport (~tens of MB) at any zoom.
 *
 * Layout: uploads/tiles/<floorId>/<z>/<x>_<y>.jpg
 *   z counts UP from 0 (single 256×256 overview). Level z+1 doubles the
 *   resolution; the top level is the map at native pixel density.
 *
 * Levels are capped at MAX_ZOOM_LEVELS so a pathological import cannot
 * fill the disk; the topmost level is then the finest available detail.
 */
import sharp from 'sharp'
import path from 'path'
import fs from 'fs'

export const TILE_SIZE = 256
export const MAX_ZOOM_LEVELS = 8

const uploadsDir = () => process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')

/** Directory holding the pyramid for a floor. */
export function tilesDirFor(floorId: string): string {
  return path.join(uploadsDir(), 'tiles', floorId)
}

/**
 * Build the pyramid for one floor image. Returns the number of levels.
 * Built into a temp directory and moved into place atomically, so a crash
 * can never leave a half-written pyramid under the real path.
 */
export async function buildTilePyramid(floorId: string, imageBuffer: Buffer): Promise<number> {
  const meta = await sharp(imageBuffer).metadata()
  const w = meta.width ?? 0
  const h = meta.height ?? 0
  if (w <= 0 || h <= 0) throw new Error('image has no dimensions')

  // Enough levels that the top level reaches native resolution (i.e. the
  // coarsest level fits in one tile), bounded by MAX_ZOOM_LEVELS.
  const levels = Math.min(
    MAX_ZOOM_LEVELS,
    Math.max(1, Math.ceil(Math.log2(Math.max(w, h) / TILE_SIZE)) + 1),
  )

  const finalDir = tilesDirFor(floorId)
  const tmpDir = path.join(uploadsDir(), 'tiles', `.tmp-${floorId}`)
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.mkdirSync(tmpDir, { recursive: true })

  // Each level is resized from the ORIGINAL image (no loss stacking), then
  // tiles are cut from a lossless intermediate. z=levels-1 is native size.
  let levelW = w
  let levelH = h
  for (let z = levels - 1; z >= 0; z--) {
    const zDir = path.join(tmpDir, String(z))
    fs.mkdirSync(zDir, { recursive: true })

    const levelBuf = await sharp(imageBuffer, { limitInputPixels: 268402689 }) // 16384² cap
      .resize(levelW, levelH, { fit: 'fill' })
      .flatten({ background: '#FFFFFF' }) // JPEG has no alpha
      .png() // lossless intermediate: one JPEG generation per tile, at the end
      .toBuffer()

    const cols = Math.ceil(levelW / TILE_SIZE)
    const rows = Math.ceil(levelH / TILE_SIZE)
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const left = tx * TILE_SIZE
        const top = ty * TILE_SIZE
        await sharp(levelBuf)
          .extract({
            left,
            top,
            width: Math.min(TILE_SIZE, levelW - left),
            height: Math.min(TILE_SIZE, levelH - top),
          })
          .jpeg({ quality: 85, mozjpeg: true })
          .toFile(path.join(zDir, `${tx}_${ty}.jpg`))
      }
    }

    levelW = Math.max(1, Math.floor(levelW / 2))
    levelH = Math.max(1, Math.floor(levelH / 2))
  }

  // Atomic swap: remove the previous pyramid, move the new one in
  fs.rmSync(finalDir, { recursive: true, force: true })
  fs.renameSync(tmpDir, finalDir)
  return levels
}

/** Remove a floor's entire pyramid. */
export function deleteTilePyramid(floorId: string): void {
  fs.rmSync(tilesDirFor(floorId), { recursive: true, force: true })
}

/**
 * Highest pyramid level available for a map of native size w×h — the
 * client picks its working level from this (must match buildTilePyramid).
 */
export function pyramidLevels(w: number, h: number): number {
  if (w <= 0 || h <= 0) return 0
  return Math.min(
    MAX_ZOOM_LEVELS,
    Math.max(1, Math.ceil(Math.log2(Math.max(w, h) / TILE_SIZE)) + 1),
  )
}
