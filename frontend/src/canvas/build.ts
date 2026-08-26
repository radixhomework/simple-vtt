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
import type { Camera } from '../types'

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

/**
 * Draw the walls overlay for build mode: bright lines through fog —
 * walls are editing handles, not fog-hidden information. Selected walls
 * get a highlight + endpoint handles.
 */
export function drawWallsOverlay(
  ctx: CanvasRenderingContext2D,
  walls: WallSegment[],
  cam: Camera,
  selected: Set<string> | null,
  wallIdOf: (w: WallSegment, index: number) => string,
) {
  ctx.save()
  ctx.lineCap = 'round'
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i]
    const [ax, ay] = worldToScreen(w.ax, w.ay, cam)
    const [bx, by] = worldToScreen(w.bx, w.by, cam)
    const isSel = selected?.has(wallIdOf(w, i)) ?? false
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
