import type { Camera, Token, FogPoint, MeasureState, Portal } from '../types'
import { worldToScreen } from './camera'
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

export function drawMap(
  ctx: CanvasRenderingContext2D,
  mapImage: HTMLImageElement | null,
  cam: Camera,
  mapOffsetX: number,
  mapOffsetY: number,
) {
  if (!mapImage) {
    ctx.fillStyle = '#111827'
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
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'
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
      ctx.fillStyle = token.color || '#4a90d9'
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
    ctx.strokeStyle = selectedId === token.id ? '#fbbf24' : token.color
    ctx.stroke()

    // Vision indicator
    if (token.has_vision && isAdmin) {
      ctx.beginPath()
      ctx.arc(sx, sy - radius - 4, 4, 0, Math.PI * 2)
      ctx.fillStyle = '#34d399'
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
    const blackLayer = new OffscreenCanvas(w, h)
    const bl = blackLayer.getContext('2d')!
    bl.fillStyle = isAdmin ? 'rgba(0,0,0,0.45)' : '#000'
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
    ctx.fillStyle = '#000'
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
    const lw = Math.max(2, 4 * cam.zoom)

    if (portal.closed) {
      // Closed door — thick brown bar
      ctx.beginPath()
      ctx.moveTo(sx1, sy1)
      ctx.lineTo(sx2, sy2)
      ctx.strokeStyle = '#a0522d'
      ctx.lineWidth = lw
      ctx.setLineDash([])
      ctx.stroke()
      // Centre knob
      ctx.beginPath()
      ctx.arc(midX, midY, lw, 0, Math.PI * 2)
      ctx.fillStyle = '#6b3010'
      ctx.fill()
    } else {
      // Open door — dashed cyan gap
      ctx.beginPath()
      ctx.moveTo(sx1, sy1)
      ctx.lineTo(sx2, sy2)
      ctx.strokeStyle = 'rgba(80,220,180,0.65)'
      ctx.lineWidth = Math.max(1.5, 2 * cam.zoom)
      ctx.setLineDash([5 * cam.zoom, 4 * cam.zoom])
      ctx.stroke()
      ctx.setLineDash([])
    }

    // Admin label when zoomed in enough
    if (isAdmin && cam.zoom > 0.45) {
      const label = portal.closed ? 'closed' : 'open'
      ctx.font = `${Math.max(9, 9 * cam.zoom)}px system-ui`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'bottom'
      ctx.fillStyle = portal.closed ? '#d2691e' : '#40c898'
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

  switch (state.tool) {
    case 'line': {
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.strokeStyle = '#f59e0b'
      ctx.lineWidth = 2
      ctx.setLineDash([6, 3])
      ctx.stroke()
      ctx.setLineDash([])
      drawDistLabel(ctx, x2, y2, dist)
      break
    }
    case 'circle': {
      const r = Math.hypot(x2 - x1, y2 - y1)
      ctx.beginPath()
      ctx.arc(x1, y1, r, 0, Math.PI * 2)
      ctx.strokeStyle = '#a78bfa'
      ctx.lineWidth = 2
      ctx.setLineDash([6, 3])
      ctx.stroke()
      ctx.setLineDash([])
      drawDistLabel(ctx, x1 + r, y1, dist)
      break
    }
    case 'square': {
      ctx.beginPath()
      ctx.rect(x1, y1, x2 - x1, y2 - y1)
      ctx.strokeStyle = '#34d399'
      ctx.lineWidth = 2
      ctx.setLineDash([6, 3])
      ctx.stroke()
      ctx.setLineDash([])
      const wGrid = Math.abs(dx) / gridSize
      const hGrid = Math.abs(dy) / gridSize
      drawDistLabel(ctx, (x1 + x2) / 2, y2, `${wGrid.toFixed(1)}×${hGrid.toFixed(1)}`)
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
      ctx.fillStyle = 'rgba(251, 146, 60, 0.25)'
      ctx.fill()
      ctx.strokeStyle = '#fb923c'
      ctx.lineWidth = 2
      ctx.setLineDash([6, 3])
      ctx.stroke()
      ctx.setLineDash([])
      drawDistLabel(ctx, x2, y2, dist)
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
