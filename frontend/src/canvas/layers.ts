/**
 * Stateless canvas painters: map, grid, tokens, portals, fog-of-war and
 * measurement overlays. Fog composites in three phases — greyscale map
 * clipped to the explored memory, holes punched for currently visible
 * areas (destination-out), and a dark layer over never-explored space.
 * Admins see fog at reduced opacity, players fully opaque.
 */
import type { Camera, Token, FogPoint, MeasureState, Portal, Stairs } from '../types'
import { worldToScreen } from './camera'
import { PALETTE } from '../theme'
import { computeVisibilityPolygon, cullWalls } from './los'
import type { WallSegment } from './los'

// Token images cache
const tokenImageCache = new Map<string, HTMLImageElement>()
const mapImageCache = new Map<string, HTMLImageElement>()

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
    img.crossOrigin = 'anonymous'
  })
}

export function getTokenImage(path: string): HTMLImageElement | null {
  return tokenImageCache.get(path) ?? null
}

export function preloadTokenImage(path: string): void {
  if (!path || tokenImageCache.has(path)) return
  const img = new Image()
  // crossOrigin must be set before src, otherwise the attribute is ignored
  img.crossOrigin = 'anonymous'
  img.src = path
  img.onload = () => tokenImageCache.set(path, img)
  img.onerror = () => console.warn('[vtt] failed to load token image:', path)
}

export function preloadMapImage(path: string, callback: (img: HTMLImageElement) => void): void {
  if (mapImageCache.has(path)) {
    callback(mapImageCache.get(path)!)
    return
  }
  const img = new Image()
  // crossOrigin must be set before src, otherwise the attribute is ignored
  img.crossOrigin = 'anonymous'
  img.src = path
  img.onload = () => {
    mapImageCache.set(path, img)
    callback(img)
  }
  img.onerror = () => console.warn('[vtt] failed to load map image:', path)
}

/**
 * Drop every cached map bitmap except `keepPath`. Multi-level tables must
 * never hold more than the active floor's image in memory — released
 * bitmaps are reclaimed by the browser's GC.
 */
export function clearMapImageCache(keepPath: string): void {
  for (const key of [...mapImageCache.keys()]) {
    if (key !== keepPath) mapImageCache.delete(key)
  }
}

/** Stairs marker: a spiral linking this floor to another level. */
export function drawStairs(
  ctx: CanvasRenderingContext2D,
  stairs: Stairs[],
  floors: Array<{ id: string; level: number; name: string }>,
  cam: Camera,
  gridSize: number,
  isAdmin: boolean,
) {
  for (const st of stairs) {
    const [sx, sy] = worldToScreen(st.from_x, st.from_y, cam)
    // Visible marker spans 0.75 grid square (pickup radius is separate)
    const r = Math.max(5, 0.75 * gridSize * cam.zoom * 0.5)
    ctx.save()
    // Disc in rose with a spiral glyph
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(138, 94, 97, 0.35)'
    ctx.fill()
    ctx.lineWidth = 2
    ctx.strokeStyle = PALETTE.rose
    ctx.stroke()
    ctx.beginPath()
    for (let a = 0; a < Math.PI * 4; a += 0.4) {
      const rr = (r * 0.75) * (a / (Math.PI * 4))
      const px = sx + Math.cos(a) * rr
      const py = sy + Math.sin(a) * rr
      if (a === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.lineWidth = 1.5
    ctx.stroke()
    // Target floor label — admins only, players just see the spiral
    if (isAdmin && cam.zoom > 0.3) {
      const target = floors.find(f => f.id === st.to_floor)
      const label = target ? (target.name || `Floor ${target.level}`) : '?'
      const up = target && target.level > (floors.find(f => f.id === st.from_floor)?.level ?? 0)
      ctx.font = `bold ${Math.max(10, 11 * cam.zoom)}px system-ui`
      const w = ctx.measureText(label).width
      ctx.fillStyle = 'rgba(30,33,28,0.75)'
      ctx.fillRect(sx - w / 2 - 4, sy + r + 2, w + 8, 16)
      ctx.fillStyle = PALETTE.parchment
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillText(`${up ? '↑' : '↓'} ${label}`, sx, sy + r + 3)
    }
    ctx.restore()
  }
}

export function drawMap(
  ctx: CanvasRenderingContext2D,
  mapImage: HTMLImageElement | null,
  cam: Camera,
  mapOffsetX: number,
  mapOffsetY: number,
) {
  if (!mapImage) {
    ctx.fillStyle = PALETTE.ink
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    return
  }
  const [sx, sy] = worldToScreen(mapOffsetX, mapOffsetY, cam)
  ctx.drawImage(mapImage, sx, sy, mapImage.width * cam.zoom, mapImage.height * cam.zoom)
}

export function drawGrid(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  gridSize: number,
  canvasW: number,
  canvasH: number,
) {
  if (gridSize <= 0 || cam.zoom < 0.15) return

  const step = gridSize * cam.zoom
  const startX = -(cam.x % gridSize) * cam.zoom
  const startY = -(cam.y % gridSize) * cam.zoom

  ctx.beginPath()
  ctx.strokeStyle = 'rgba(30,33,28,0.18)'
  ctx.lineWidth = 0.5

  for (let x = startX; x < canvasW; x += step) {
    ctx.moveTo(x, 0)
    ctx.lineTo(x, canvasH)
  }
  for (let y = startY; y < canvasH; y += step) {
    ctx.moveTo(0, y)
    ctx.lineTo(canvasW, y)
  }
  ctx.stroke()
}

export function drawTokens(
  ctx: CanvasRenderingContext2D,
  tokens: Token[],
  cam: Camera,
  gridSize: number,
  selectedId: string | null,
  currentUser: string,
  isAdmin: boolean,
) {
  for (const token of tokens) {
    const [sx, sy] = worldToScreen(token.x, token.y, cam)
    const radius = (gridSize * token.size * cam.zoom) / 2

    const img = token.icon_path ? getTokenImage(token.icon_path) : null

    ctx.save()
    ctx.beginPath()
    ctx.arc(sx, sy, radius, 0, Math.PI * 2)
    ctx.clip()

    if (img) {
      ctx.drawImage(img, sx - radius, sy - radius, radius * 2, radius * 2)
    } else {
      // Fallback: colored circle
      ctx.fillStyle = token.color || PALETTE.moss
      ctx.fill()
      // Draw initials
      ctx.fillStyle = '#fff'
      ctx.font = `bold ${Math.max(10, radius * 0.7)}px system-ui`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(token.name.slice(0, 2).toUpperCase(), sx, sy)
    }

    ctx.restore()

    // Border
    ctx.beginPath()
    ctx.arc(sx, sy, radius, 0, Math.PI * 2)
    ctx.lineWidth = selectedId === token.id ? 3 : 1.5
    ctx.strokeStyle = selectedId === token.id ? PALETTE.copper : token.color
    ctx.stroke()

    // Vision indicator
    if (token.has_vision && isAdmin) {
      ctx.beginPath()
      ctx.arc(sx, sy - radius - 4, 4, 0, Math.PI * 2)
      ctx.fillStyle = PALETTE.moss
      ctx.fill()
    }

    // Name label
    if (cam.zoom > 0.4) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)'
      const label = token.name || '?'
      const fontSize = Math.max(9, 11 * cam.zoom)
      ctx.font = `${fontSize}px system-ui`
      const textW = ctx.measureText(label).width
      ctx.fillRect(sx - textW / 2 - 3, sy + radius + 2, textW + 6, fontSize + 2)
      ctx.fillStyle = '#fff'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillText(label, sx, sy + radius + 3)
    }
  }
}

// ── Explored-canvas helpers ────────────────────────────────────────────────────

/**
 * Stamp the currently-visible areas (world space) onto `exploredCanvas` so
 * they can be shown in greyscale when no longer in sight.
 * exploredCanvas uses world-pixel coordinates, same origin as the map.
 */
export function updateExplored(
  exploredCanvas: OffscreenCanvas,
  tokens: Token[],
  fogPoints: FogPoint[],
  walls: WallSegment[],
  gridSize: number,
) {
  const ctx = exploredCanvas.getContext('2d')!
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = '#fff'

  for (const token of tokens) {
    if (!token.has_vision) continue
    const r = token.vision_radius * gridSize
    const nearby = cullWalls(walls, token.x, token.y, r)

    if (nearby.length > 0) {
      const poly = computeVisibilityPolygon(token.x, token.y, r, nearby)
      if (poly.length > 2) {
        ctx.save()
        ctx.beginPath()
        ctx.arc(token.x, token.y, r, 0, Math.PI * 2)
        ctx.clip()
        ctx.beginPath()
        ctx.moveTo(poly[0].x, poly[0].y)
        for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y)
        ctx.closePath()
        ctx.fill()
        ctx.restore()
      }
    } else {
      ctx.beginPath()
      ctx.arc(token.x, token.y, r, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  for (const pt of fogPoints) {
    ctx.beginPath()
    ctx.arc(pt.x, pt.y, pt.radius * gridSize, 0, Math.PI * 2)
    ctx.fill()
  }
}

// ── Internal: stamp vision holes with destination-out ─────────────────────────

function punchVision(
  ctx: CanvasRenderingContext2D,
  tokens: Token[],
  fogPoints: FogPoint[],
  walls: WallSegment[],
  cam: Camera,
  gridSize: number,
) {
  const screenWalls = walls.map(wl => ({
    ax: (wl.ax - cam.x) * cam.zoom, ay: (wl.ay - cam.y) * cam.zoom,
    bx: (wl.bx - cam.x) * cam.zoom, by: (wl.by - cam.y) * cam.zoom,
  }))

  for (const token of tokens) {
    if (!token.has_vision) continue
    const [sx, sy] = worldToScreen(token.x, token.y, cam)
    const visionPx = token.vision_radius * gridSize * cam.zoom

    if (screenWalls.length > 0) {
      const nearby = cullWalls(screenWalls, sx, sy, visionPx)
      const poly = computeVisibilityPolygon(sx, sy, visionPx, nearby)
      if (poly.length > 2) {
        ctx.save()
        ctx.beginPath()
        ctx.arc(sx, sy, visionPx, 0, Math.PI * 2)
        ctx.clip()
        ctx.beginPath()
        ctx.moveTo(poly[0].x, poly[0].y)
        for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y)
        ctx.closePath()
        ctx.fillStyle = 'rgba(0,0,0,1)'
        ctx.fill()
        ctx.restore()
      }
    } else {
      const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, visionPx)
      grad.addColorStop(0, 'rgba(0,0,0,1)')
      grad.addColorStop(0.7, 'rgba(0,0,0,1)')
      grad.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.beginPath()
      ctx.arc(sx, sy, visionPx, 0, Math.PI * 2)
      ctx.fillStyle = grad
      ctx.fill()
    }
  }

  for (const point of fogPoints) {
    const [sx, sy] = worldToScreen(point.x, point.y, cam)
    const radius = point.radius * gridSize * cam.zoom
    const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, radius)
    grad.addColorStop(0, 'rgba(0,0,0,1)')
    grad.addColorStop(0.8, 'rgba(0,0,0,1)')
    grad.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.beginPath()
    ctx.arc(sx, sy, radius, 0, Math.PI * 2)
    ctx.fillStyle = grad
    ctx.fill()
  }
}

// ── Main fog renderer ─────────────────────────────────────────────────────────

// Scratch layer for the never-explored overlay, reused across frames —
// allocating a full-screen OffscreenCanvas per frame churns mobile GCs.
let fogScratch: OffscreenCanvas | null = null
function getFogScratch(w: number, h: number): OffscreenCanvas {
  if (fogScratch?.width !== w || fogScratch?.height !== h) {
    fogScratch = new OffscreenCanvas(w, h)
  }
  const ctx = fogScratch.getContext('2d')!
  // Phase 3 leaves globalCompositeOperation at 'destination-out'; a reused
  // context must be reset or the next fillRect would erase instead of fill.
  ctx.globalCompositeOperation = 'source-over'
  ctx.clearRect(0, 0, w, h)
  return fogScratch
}

export function drawFog(
  ctx: CanvasRenderingContext2D,
  tokens: Token[],
  fogPoints: FogPoint[],
  walls: WallSegment[],
  cam: Camera,
  gridSize: number,
  isAdmin: boolean,
  exploredCanvas?: OffscreenCanvas | null,
  mapImage?: HTMLImageElement | null,
  mapOffsetX = 0,
  mapOffsetY = 0,
) {
  const w = ctx.canvas.width
  const h = ctx.canvas.height
  ctx.save()

  if (exploredCanvas && mapImage) {
    // ── Phase 1: greyscale map clipped to explored areas ──────────────────────
    ctx.clearRect(0, 0, w, h)

    ctx.save()
    ctx.filter = 'grayscale(1) brightness(0.55)'
    const [sx, sy] = worldToScreen(mapOffsetX, mapOffsetY, cam)
    ctx.drawImage(mapImage, sx, sy, mapImage.width * cam.zoom, mapImage.height * cam.zoom)
    ctx.filter = 'none'
    ctx.restore()

    // Mask: keep only pixels that fall inside explored regions
    ctx.globalCompositeOperation = 'destination-in'
    ctx.save()
    ctx.setTransform(cam.zoom, 0, 0, cam.zoom, -cam.x * cam.zoom, -cam.y * cam.zoom)
    ctx.drawImage(exploredCanvas, 0, 0)
    ctx.restore()

    // ── Phase 2: punch out currently-visible areas (full colour shows through) ─
    ctx.globalCompositeOperation = 'destination-out'
    punchVision(ctx, tokens, fogPoints, walls, cam, gridSize)

    // ── Phase 3: black layer for never-explored areas ─────────────────────────
    // Build a black canvas with the explored region cut out, then composite it
    ctx.globalCompositeOperation = 'source-over'
    const blackLayer = getFogScratch(w, h)
    const bl = blackLayer.getContext('2d')!
    bl.fillStyle = isAdmin ? 'rgba(30,33,28,0.45)' : PALETTE.ink
    bl.fillRect(0, 0, w, h)
    bl.globalCompositeOperation = 'destination-out'
    bl.save()
    bl.setTransform(cam.zoom, 0, 0, cam.zoom, -cam.x * cam.zoom, -cam.y * cam.zoom)
    bl.drawImage(exploredCanvas, 0, 0)
    bl.restore()
    ctx.drawImage(blackLayer, 0, 0)

  } else {
    // ── Fallback: no explored tracking (no map image loaded) ─────────────────
    ctx.globalAlpha = isAdmin ? 0.5 : 1.0
    ctx.fillStyle = PALETTE.ink
    ctx.fillRect(0, 0, w, h)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'destination-out'
    punchVision(ctx, tokens, fogPoints, walls, cam, gridSize)
    ctx.globalCompositeOperation = 'source-over'
  }

  ctx.restore()
}

export function drawPortals(
  ctx: CanvasRenderingContext2D,
  portals: Portal[],
  cam: Camera,
  isAdmin: boolean,
) {

  if (portals.length === 0) return
  ctx.save()
  ctx.lineCap = 'round'

  for (const portal of portals) {
    const [sx1, sy1] = worldToScreen(portal.x1, portal.y1, cam)
    const [sx2, sy2] = worldToScreen(portal.x2, portal.y2, cam)
    const midX = (sx1 + sx2) / 2
    const midY = (sy1 + sy2) / 2
    const lw = Math.max(3.5, 6 * cam.zoom)

    const isWindow = portal.kind === 'window'
    if (portal.closed) {
      // Closed portal — thick bar. Windows are drawn in rose with glass
      // ticks so admins can tell them from copper doors at a glance.
      ctx.beginPath()
      ctx.moveTo(sx1, sy1)
      ctx.lineTo(sx2, sy2)
      ctx.strokeStyle = isWindow ? PALETTE.rose : PALETTE.copper
      ctx.lineWidth = lw
      ctx.setLineDash([])
      ctx.stroke()
      if (isWindow) {
        // Glass ticks along the frame
        const ticks = 3
        ctx.strokeStyle = PALETTE.parchment
        ctx.lineWidth = Math.max(1, lw * 0.25)
        for (let t = 1; t <= ticks; t++) {
          const f = t / (ticks + 1)
          const nx = -(sy2 - sy1), ny = sx2 - sx1
          const nl = Math.hypot(nx, ny) || 1
          const px = sx1 + (sx2 - sx1) * f, py = sy1 + (sy2 - sy1) * f
          ctx.beginPath()
          ctx.moveTo(px - nx / nl * lw * 0.5, py - ny / nl * lw * 0.5)
          ctx.lineTo(px + nx / nl * lw * 0.5, py + ny / nl * lw * 0.5)
          ctx.stroke()
        }
      } else {
        // Door centre knob
        ctx.beginPath()
        ctx.arc(midX, midY, lw, 0, Math.PI * 2)
        ctx.fillStyle = PALETTE.earth
        ctx.fill()
      }
    } else {
      // Open portal — dashed gap (moss for doors, rose for windows)
      ctx.beginPath()
      ctx.moveTo(sx1, sy1)
      ctx.lineTo(sx2, sy2)
      ctx.strokeStyle = isWindow ? 'rgba(138, 94, 97, 0.75)' : 'rgba(120,150,110,0.75)'
      ctx.lineWidth = Math.max(2.5, 3 * cam.zoom)
      ctx.setLineDash([5 * cam.zoom, 4 * cam.zoom])
      ctx.stroke()
      ctx.setLineDash([])
    }

    // Admin label when zoomed in enough
    if (isAdmin && cam.zoom > 0.45) {
      const label = `${isWindow ? 'window' : 'door'} ${portal.closed ? '· closed' : '· open'}${portal.locked ? ' · 🔒' : ''}`
      ctx.font = `${Math.max(9, 9 * cam.zoom)}px system-ui`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'bottom'
      ctx.fillStyle = portal.closed ? (isWindow ? PALETTE.rose : PALETTE.copper) : PALETTE.moss
      ctx.fillText(label, midX, midY - lw - 2)
    }
  }
  ctx.restore()
}

export function drawMeasure(
  ctx: CanvasRenderingContext2D,
  state: MeasureState,
  cam: Camera,
  gridSize: number,
  unitSize = 1,
  unit = '',
) {
  if (!state.active && !state.persist) return

  const [x1, y1] = worldToScreen(state.startX, state.startY, cam)
  const [x2, y2] = worldToScreen(state.endX, state.endY, cam)

  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  const dx = state.endX - state.startX
  const dy = state.endY - state.startY
  const dist = Math.hypot(dx, dy) / gridSize

  // Convert a grid-square distance to the configured real-world unit
  const fmt = (sq: number) => {
    if (!unit) return `${sq.toFixed(1)} sq`
    const v = sq * unitSize
    return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)} ${unit}`
  }

  switch (state.tool) {
    case 'line': {
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.strokeStyle = PALETTE.copper
      ctx.lineWidth = 2
      ctx.setLineDash([6, 3])
      ctx.stroke()
      ctx.setLineDash([])
      drawDistLabel(ctx, x2, y2, fmt(dist))
      break
    }
    case 'circle': {
      const r = Math.hypot(x2 - x1, y2 - y1)
      ctx.beginPath()
      ctx.arc(x1, y1, r, 0, Math.PI * 2)
      ctx.strokeStyle = PALETTE.rose
      ctx.lineWidth = 2
      ctx.setLineDash([6, 3])
      ctx.stroke()
      ctx.setLineDash([])
      drawDistLabel(ctx, x1 + r, y1, fmt(dist))
      break
    }
    case 'square': {
      ctx.beginPath()
      ctx.rect(x1, y1, x2 - x1, y2 - y1)
      ctx.strokeStyle = PALETTE.moss
      ctx.lineWidth = 2
      ctx.setLineDash([6, 3])
      ctx.stroke()
      ctx.setLineDash([])
      const wGrid = Math.abs(dx) / gridSize
      const hGrid = Math.abs(dy) / gridSize
      drawDistLabel(ctx, (x1 + x2) / 2, y2, `${fmt(wGrid)}×${fmt(hGrid)}`)
      break
    }
    case 'cone': {
      const angle = Math.atan2(y2 - y1, x2 - x1)
      const halfAngle = Math.PI / 4 // 45° half-angle = 90° cone
      const r = Math.hypot(x2 - x1, y2 - y1)
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.arc(x1, y1, r, angle - halfAngle, angle + halfAngle)
      ctx.closePath()
      ctx.fillStyle = 'rgba(118, 96, 78, 0.30)'
      ctx.fill()
      ctx.strokeStyle = PALETTE.earth
      ctx.lineWidth = 2
      ctx.setLineDash([6, 3])
      ctx.stroke()
      ctx.setLineDash([])
      drawDistLabel(ctx, x2, y2, fmt(dist))
      break
    }
  }

  ctx.restore()
}

function drawDistLabel(ctx: CanvasRenderingContext2D, x: number, y: number, value: string | number) {
  const label = typeof value === 'number' ? `${value.toFixed(1)} sq` : value
  ctx.font = 'bold 13px system-ui'
  const w = ctx.measureText(label).width
  ctx.fillStyle = 'rgba(0,0,0,0.75)'
  ctx.fillRect(x + 6, y - 9, w + 8, 18)
  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, x + 10, y)
}
