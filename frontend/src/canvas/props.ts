/**
 * Map props — decorative assets (trees, furniture…) drawn on the map
 * canvas between the grid and the tokens. Props are anchored at their
 * center in world px, rotated around it, scaled to `size` px regardless of
 * the source resolution. Purely visual: they never block sight/movement.
 */
import type { Camera, Prop } from '../types'

/** Decoded-image cache keyed by asset path (bounded by the map's needs). */
const imageCache = new Map<string, HTMLImageElement>()
const pending = new Set<string>()

/** Warm the cache; re-render via `onChange` once the bitmap lands. */
export function preloadPropImage(path: string, onChange: () => void): void {
  if (imageCache.has(path) || pending.has(path)) return
  pending.add(path)
  const img = new Image()
  img.onload = () => { imageCache.set(path, img); pending.delete(path); onChange() }
  img.onerror = () => { pending.delete(path) }
  img.src = path
}

/** Forget every cached bitmap (floor switch / page teardown). */
export function clearPropImageCache(): void {
  imageCache.clear()
  pending.clear()
}

/** Screen-space size of the prop's square (unrotated). */
export function propScreenSize(p: Prop, cam: Camera): number {
  return Math.max(4, p.size * cam.zoom)
}

/** Draw all props (already z-sorted by the server). */
export function drawProps(
  ctx: CanvasRenderingContext2D,
  props: Prop[],
  cam: Camera,
): void {
  for (const p of props) {
    const img = imageCache.get(p.asset_path)
    const s = propScreenSize(p, cam)
    // World anchor → screen (no rotation on the anchor itself)
    const sx = (p.x - cam.x) * cam.zoom
    const sy = (p.y - cam.y) * cam.zoom
    ctx.save()
    ctx.globalAlpha = p.opacity
    ctx.translate(sx, sy)
    if (p.rotation) ctx.rotate((p.rotation * Math.PI) / 180)
    if (img) {
      ctx.drawImage(img, -s / 2, -s / 2, s, s)
    } else {
      // Placeholder frame until the bitmap arrives
      ctx.strokeStyle = '#b0a998'
      ctx.lineWidth = 1.5
      ctx.setLineDash([4, 3])
      ctx.strokeRect(-s / 2, -s / 2, s, s)
      ctx.setLineDash([])
      preloadPropImage(p.asset_path, () => {})
    }
    ctx.restore()
  }
}

/** Is the world point inside the prop's rotated square? */
export function propHit(p: Prop, wx: number, wy: number): boolean {
  const dx = wx - p.x
  const dy = wy - p.y
  const a = (-p.rotation * Math.PI) / 180
  const rx = dx * Math.cos(a) - dy * Math.sin(a)
  const ry = dx * Math.sin(a) + dy * Math.cos(a)
  const h = p.size / 2
  return Math.abs(rx) <= h && Math.abs(ry) <= h
}

/** Topmost prop under the point (z order — search from the end). */
export function pickProp(props: Prop[], wx: number, wy: number): Prop | null {
  for (let i = props.length - 1; i >= 0; i--) {
    if (propHit(props[i], wx, wy)) return props[i]
  }
  return null
}

/** Selection overlay for one prop: outline + resize/rotate handles. */
export function drawPropSelection(
  ctx: CanvasRenderingContext2D,
  p: Prop,
  cam: Camera,
): void {
  const s = propScreenSize(p, cam)
  const sx = (p.x - cam.x) * cam.zoom
  const sy = (p.y - cam.y) * cam.zoom
  ctx.save()
  ctx.translate(sx, sy)
  ctx.rotate((p.rotation * Math.PI) / 180)
  // outline
  ctx.strokeStyle = '#ffd54f'
  ctx.lineWidth = 2
  ctx.strokeRect(-s / 2, -s / 2, s, s)
  // resize handles: 4 corners
  ctx.fillStyle = '#ffd54f'
  for (const [hx, hy] of [[-s/2, -s/2], [s/2, -s/2], [s/2, s/2], [-s/2, s/2]] as Array<[number, number]>) {
    ctx.beginPath()
    ctx.arc(hx, hy, 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = '#1e211c'
    ctx.stroke()
  }
  // rotate handle: above the top edge (in prop space, so it rotates with it)
  const ry = -s / 2 - 22
  ctx.strokeStyle = '#ffd54f'
  ctx.lineWidth = 1.5
  ctx.setLineDash([3, 3])
  ctx.beginPath()
  ctx.moveTo(0, -s / 2)
  ctx.lineTo(0, ry - 6)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.beginPath()
  ctx.arc(0, ry, 6, 0, Math.PI * 2)
  ctx.fillStyle = '#4fc3f7'
  ctx.fill()
  ctx.strokeStyle = '#1e211c'
  ctx.stroke()
  ctx.restore()
}

/** Handle kinds the selection offers, in world coordinates. */
export type PropHandle = 'body' | 'rotate' | 'ne' | 'se' | 'sw' | 'nw'

/** Which handle of `p` is near the world point (tol in SCREEN px)? */
export function pickPropHandle(p: Prop, wx: number, wy: number, cam: Camera): PropHandle | null {
  const tol = Math.max(6, 6 / cam.zoom)
  // Rotate handle first — it sits apart from the body
  const a = (p.rotation * Math.PI) / 180
  const off = -p.size / 2 - 22 / cam.zoom
  const cos = Math.cos(a), sin = Math.sin(a)
  // handle offset in prop-local coords (0, off): rotate to world
  const rw = { x: p.x + 0 * cos - off * sin, y: p.y + 0 * sin + off * cos }
  if (Math.hypot(wx - rw.x, wy - rw.y) <= tol) return 'rotate'
  const h = p.size / 2
  const corners: Array<[PropHandle, number, number]> = [
    ['nw', -h, -h], ['ne', h, -h], ['se', h, h], ['sw', -h, h],
  ]
  for (const [kind, lx, ly] of corners) {
    const cwx = p.x + lx * cos - ly * sin
    const cwy = p.y + lx * sin + ly * cos
    if (Math.hypot(wx - cwx, wy - cwy) <= tol) return kind
  }
  if (propHit(p, wx, wy)) return 'body'
  return null
}
