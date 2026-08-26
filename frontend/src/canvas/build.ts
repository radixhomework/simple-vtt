/**
 * Build mode: DM-only authoring mode separate from play mode.
 *
 * The map page has two modes — 'play' (the default; exactly the classic
 * behavior) and 'build' (authoring walls/doors/grid). Every build tool
 * lives exclusively in build mode; play tools never render there and
 * vice versa. The mode is admin-only and persisted per table.
 */

import type { WallSegment } from './los'
import { worldToScreen } from './camera'
import type { Camera, WallRecord } from '../types'

export type PageMode = 'play' | 'build'

/** localStorage key per table: `vtt:mode:<tableId>`. */
const modeKey = (tableId: string) => `vtt:mode:${tableId}`

/** Load the persisted mode (play when never set / not admin). */
export function loadMode(tableId: string, isAdmin: boolean): PageMode {
  if (!isAdmin) return 'play'
  try {
    const v = localStorage.getItem(modeKey(tableId))
    return v === 'build' ? 'build' : 'play'
  } catch { return 'play' }
}

/** Persist and return the new mode. */
export function saveMode(tableId: string, mode: PageMode): void {
  try { localStorage.setItem(modeKey(tableId), mode) } catch { /* private mode */ }
}

/** Distance from point P to segment AB (world px). */
export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(px - ax, py - ay)
  let t = ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** Wall record whose body or endpoints are within `tol` world px of (x,y).
 *  Returns [record, grab] where grab says what was hit: 'body' | 'a' | 'b'. */
export function pickWall(walls: WallRecord[], x: number, y: number, tol: number): { wall: WallRecord; grab: 'body' | 'a' | 'b' } | null {
  let best: { wall: WallRecord; grab: 'body' | 'a' | 'b' } | null = null
  let bestD = tol
  for (const w of walls) {
    const da = Math.hypot(x - w.ax, y - w.ay)
    if (da <= bestD) { best = { wall: w, grab: 'a' }; bestD = da; continue }
    const db = Math.hypot(x - w.bx, y - w.by)
    if (db <= bestD) { best = { wall: w, grab: 'b' }; bestD = db; continue }
    const dBody = distToSegment(x, y, w.ax, w.ay, w.bx, w.by)
    if (dBody <= bestD) { best = { wall: w, grab: 'body' }; bestD = dBody }
  }
  return best
}

/** Walls whose any part intersects the world-space rect. */
export function wallsInRect(walls: WallRecord[], x0: number, y0: number, x1: number, y1: number): WallRecord[] {
  const rx0 = Math.min(x0, x1), rx1 = Math.max(x0, x1)
  const ry0 = Math.min(y0, y1), ry1 = Math.max(y0, y1)
  return walls.filter(w => {
    // Seg-rect overlap: cheap AABB pretest then segment-rect intersection
    const sx0 = Math.min(w.ax, w.bx), sx1 = Math.max(w.ax, w.bx)
    const sy0 = Math.min(w.ay, w.by), sy1 = Math.max(w.ay, w.by)
    if (sx1 < rx0 || sx0 > rx1 || sy1 < ry0 || sy0 > ry1) return false
    return true
  })
}

/**
 * Draw the walls overlay for build mode: bright lines through fog —
 * walls are editing handles, not fog-hidden information. Selected walls
 * get a highlight + endpoint handles.
 */
export function drawWallsOverlay(
  ctx: CanvasRenderingContext2D,
  walls: WallRecord[],
  cam: Camera,
  selected: Set<string>,
) {
  ctx.save()
  ctx.lineCap = 'round'
  for (const w of walls) {
    const [ax, ay] = worldToScreen(w.ax, w.ay, cam)
    const [bx, by] = worldToScreen(w.bx, w.by, cam)
    const isSel = selected.has(w.id)
    ctx.beginPath()
    ctx.moveTo(ax, ay)
    ctx.lineTo(bx, by)
    ctx.strokeStyle = isSel ? '#ffd54f' : '#ff5252'
    ctx.lineWidth = isSel ? 5 : 3
    ctx.globalAlpha = 0.95
    ctx.stroke()
    // Endpoint dots (grab handles)
    ctx.beginPath()
    ctx.arc(ax, ay, isSel ? 6 : 3.5, 0, Math.PI * 2)
    ctx.arc(bx, by, isSel ? 6 : 3.5, 0, Math.PI * 2)
    ctx.fillStyle = isSel ? '#ffd54f' : '#ffab91'
    ctx.fill()
  }
  ctx.restore()
}

/** Draw the rubber-band marquee rectangle (screen space). */
export function drawMarquee(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  ctx.save()
  ctx.strokeStyle = '#ffd54f'
  ctx.fillStyle = 'rgba(255, 213, 79, 0.08)'
  ctx.lineWidth = 1.5
  ctx.setLineDash([6, 4])
  ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0))
  ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0))
  ctx.restore()
}

/** Draw the in-progress wall segment ghost while drawing. */
export function drawWallGhost(ctx: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number, cam: Camera): void {
  const [sx, sy] = worldToScreen(ax, ay, cam)
  const [ex, ey] = worldToScreen(bx, by, cam)
  ctx.save()
  ctx.strokeStyle = '#ffd54f'
  ctx.lineWidth = 3
  ctx.setLineDash([8, 5])
  ctx.beginPath()
  ctx.moveTo(sx, sy)
  ctx.lineTo(ex, ey)
  ctx.stroke()
  ctx.restore()
}

/** Portal record view for build tools (subset of Portal). */
export interface PortalLike {
  id: string
  x1: number
  y1: number
  x2: number
  y2: number
  kind: 'door' | 'window'
  closed: boolean
}

/** Portal whose segment is within `tol` world px of (x, y). */
export function pickPortalBuild(portals: PortalLike[], x: number, y: number, tol: number): PortalLike | null {
  let best: PortalLike | null = null
  let bestD = tol
  for (const p of portals) {
    const d = distToSegment(x, y, p.x1, p.y1, p.x2, p.y2)
    if (d <= bestD) { best = p; bestD = d }
  }
  return best
}

/** Portal pick with endpoint handles — mirrors pickWall's grab semantics:
 *  near-an-endpoint returns that endpoint, otherwise the body. */
export function pickPortalGrab(portals: PortalLike[], x: number, y: number, tol: number): { portal: PortalLike; grab: 'body' | 'a' | 'b' } | null {
  // Endpoints win over the body (they sit ON the segment)
  for (const p of portals) {
    if (Math.hypot(x - p.x1, y - p.y1) <= tol) return { portal: p, grab: 'a' }
    if (Math.hypot(x - p.x2, y - p.y2) <= tol) return { portal: p, grab: 'b' }
  }
  const hit = pickPortalBuild(portals, x, y, tol)
  return hit ? { portal: hit, grab: 'body' } : null
}

/** Portals whose segment intersects the world rect (marquee). */
export function portalsInRect(portals: PortalLike[], x0: number, y0: number, x1: number, y1: number): PortalLike[] {
  const minX = Math.min(x0, x1), maxX = Math.max(x0, x1)
  const minY = Math.min(y0, y1), maxY = Math.max(y0, y1)
  const segInRect = (ax: number, ay: number, bx: number, by: number) => {
    // cheap conservative test: bounding-box overlap + endpoint/center sample
    if (Math.max(ax, bx) < minX || Math.min(ax, bx) > maxX) return false
    if (Math.max(ay, by) < minY || Math.min(ay, by) > maxY) return false
    if ((ax >= minX && ax <= maxX && ay >= minY && ay <= maxY)
      || (bx >= minX && bx <= maxX && by >= minY && by <= maxY)) return true
    const cx = (ax + bx) / 2, cy = (ay + by) / 2
    return cx >= minX && cx <= maxX && cy >= minY && cy <= maxY
  }
  return portals.filter(p => segInRect(p.x1, p.y1, p.x2, p.y2))
}

/** Build-mode portals overlay: every portal, thicker and brighter than the
 *  play-mode rendering, through fog — editing handles. */
export function drawPortalsBuild(ctx: CanvasRenderingContext2D, portals: PortalLike[], cam: Camera, selectedIds?: Set<string>): void {
  ctx.save()
  ctx.lineCap = 'round'
  for (const p of portals) {
    const [sx1, sy1] = worldToScreen(p.x1, p.y1, cam)
    const [sx2, sy2] = worldToScreen(p.x2, p.y2, cam)
    const selected = selectedIds?.has(p.id) === true
    ctx.beginPath()
    ctx.moveTo(sx1, sy1)
    ctx.lineTo(sx2, sy2)
    ctx.strokeStyle = p.kind === 'window' ? '#4fc3f7' : '#ffb74d'
    ctx.lineWidth = (p.closed ? 6 : 4) + (selected ? 2 : 0)
    ctx.globalAlpha = 0.95
    ctx.stroke()
    if (!p.closed) {
      // open door: gap marker
      ctx.beginPath()
      ctx.arc((sx1 + sx2) / 2, (sy1 + sy2) / 2, 3, 0, Math.PI * 2)
      ctx.fillStyle = '#ffd54f'
      ctx.fill()
    }
    if (selected) {
      // Endpoint handles — same affordance as selected walls
      for (const [hx, hy] of [[sx1, sy1], [sx2, sy2]] as Array<[number, number]>) {
        ctx.beginPath()
        ctx.arc(hx, hy, 5, 0, Math.PI * 2)
        ctx.fillStyle = '#ffd54f'
        ctx.fill()
        ctx.lineWidth = 1.5
        ctx.strokeStyle = '#1e211c'
        ctx.stroke()
      }
    }
  }
  ctx.restore()
}
