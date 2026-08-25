/**
 * Line-of-sight geometry: wall segments (UVTT static walls + closed
 * portals), segment intersection, visibility polygons and movement
 * blocking (tokens may not cross or land on a wall).
 */
export interface WallSegment {
  ax: number; ay: number
  bx: number; by: number
}

export interface Point { x: number; y: number }

// True when segment AB crosses segment CD (exclusive of shared endpoints)
function segmentsCross(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const d1x = bx - ax, d1y = by - ay
  const d2x = dx - cx, d2y = dy - cy
  const denom = d1x * d2y - d1y * d2x
  if (Math.abs(denom) < 1e-10) return false          // parallel / collinear
  const t = ((cx - ax) * d2y - (cy - ay) * d2x) / denom
  const s = ((cx - ax) * d1y - (cy - ay) * d1x) / denom
  const eps = 1e-6
  return t > eps && t < 1 - eps && s > eps && s < 1 - eps
}

/**
 * Returns true if the straight-line path from (x1,y1) to (x2,y2)
 * crosses any wall segment.  Returns false when there are no walls.
 */
export function pathCrossesWall(
  x1: number, y1: number,
  x2: number, y2: number,
  walls: WallSegment[],
): boolean {
  for (const w of walls) {
    if (segmentsCross(x1, y1, x2, y2, w.ax, w.ay, w.bx, w.by)) return true
  }
  return false
}

/**
 * True when the point lies within `eps` of any wall segment. Needed because
 * pathCrossesWall treats wall endpoints as walkable: without this check a
 * token could land exactly on a wall line, then step through to the other
 * side on the next move.
 */
export function pointOnWall(
  x: number, y: number,
  walls: WallSegment[],
  eps = 2,
): boolean {
  for (const w of walls) {
    const dx = w.bx - w.ax, dy = w.by - w.ay
    const lenSq = dx * dx + dy * dy
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((x - w.ax) * dx + (y - w.ay) * dy) / lenSq))
    const dist = Math.hypot(x - (w.ax + t * dx), y - (w.ay + t * dy))
    if (dist <= eps) return true
  }
  return false
}

// t along ray from (ox,oy) at angle where it hits segment (ax,ay)-(bx,by), or null
function raySegmentT(
  ox: number, oy: number, angle: number,
  ax: number, ay: number, bx: number, by: number,
): number | null {
  const rdx = Math.cos(angle), rdy = Math.sin(angle)
  const sdx = bx - ax,        sdy = by - ay
  const denom = rdx * sdy - rdy * sdx
  if (Math.abs(denom) < 1e-10) return null
  const t = ((ax - ox) * sdy - (ay - oy) * sdx) / denom
  const u = ((ax - ox) * rdy - (ay - oy) * rdx) / denom
  if (t >= 0 && u >= 0 && u <= 1) return t
  return null
}

/**
 * Compute a visibility polygon from (ox, oy) up to radius, blocked by walls.
 * All coordinates are in the same space (screen or world — caller's choice).
 */
export function computeVisibilityPolygon(
  ox: number, oy: number,
  radius: number,
  walls: WallSegment[],
): Point[] {
  const R = radius
  // Bounding box walls so rays always terminate
  const bounds: WallSegment[] = [
    { ax: ox - R, ay: oy - R, bx: ox + R, by: oy - R },
    { ax: ox + R, ay: oy - R, bx: ox + R, by: oy + R },
    { ax: ox + R, ay: oy + R, bx: ox - R, by: oy + R },
    { ax: ox - R, ay: oy + R, bx: ox - R, by: oy - R },
  ]
  const allWalls = [...walls, ...bounds]

  // Collect angles toward every endpoint (plus tiny offsets to peek around
  // corners). UVTT polylines share endpoints massively — a vertex where
  // four wall segments meet would otherwise cast the same three rays four
  // times — so angles are deduplicated by quantized direction.
  const angles: number[] = []
  const seen = new Set<number>()
  for (const w of allWalls) {
    for (const [px, py] of [[w.ax, w.ay], [w.bx, w.by]]) {
      const a = Math.atan2(py - oy, px - ox)
      // Quantize to ~0.0001 rad: enough to merge true duplicates while
      // keeping the deliberate ±0.00001 corner-peek triplets distinct
      const q = Math.round(a * 10000)
      if (seen.has(q)) continue
      seen.add(q)
      angles.push(a - 0.00001, a, a + 0.00001)
    }
  }

  // For each angle cast a ray and find the nearest wall hit
  const pts: Array<Point & { angle: number }> = []
  for (const angle of angles) {
    let minT = Infinity
    for (const w of allWalls) {
      const t = raySegmentT(ox, oy, angle, w.ax, w.ay, w.bx, w.by)
      if (t !== null && t < minT) minT = t
    }
    if (isFinite(minT)) {
      pts.push({ x: ox + Math.cos(angle) * minT, y: oy + Math.sin(angle) * minT, angle })
    }
  }

  pts.sort((a, b) => a.angle - b.angle)
  return pts
}

/**
 * Parse only the static line_of_sight walls from UVTT metadata.
 * Portals are now managed separately via the DB (see Portal type).
 */
export function parseStaticWalls(uvtMetadata: string, gridSize: number): WallSegment[] {
  const walls: WallSegment[] = []
  try {
    const meta = JSON.parse(uvtMetadata)
    if (Array.isArray(meta.line_of_sight)) {
      for (const polyline of meta.line_of_sight as Array<Array<{ x: number; y: number }>>) {
        if (polyline.length < 2) continue
        for (let i = 0; i + 1 < polyline.length; i++) {
          const a = polyline[i], b = polyline[i + 1]
          walls.push({
            ax: a.x * gridSize, ay: a.y * gridSize,
            bx: b.x * gridSize, by: b.y * gridSize,
          })
        }
      }
    }
  } catch { /* not UVTT or no walls */ }
  return walls
}

/** Convert closed portals to wall segments for LOS. */
/**
 * Movement blockers: every closed portal (doors and windows alike — an open
 * window is passable, a closed one is not).
 */
export function portalWalls(portals: Array<{ x1: number; y1: number; x2: number; y2: number; closed: boolean }>): WallSegment[] {
  return portals
    .filter(p => p.closed)
    .map(p => ({ ax: p.x1, ay: p.y1, bx: p.x2, by: p.y2 }))
}

/**
 * Sight blockers: only closed doors. Closed windows stay transparent — a
 * token sees through glass but cannot walk through it.
 */
export function portalSightWalls(portals: Array<{ x1: number; y1: number; x2: number; y2: number; closed: boolean; kind?: 'door' | 'window' }>): WallSegment[] {
  return portals
    .filter(p => p.closed && p.kind !== 'window')
    .map(p => ({ ax: p.x1, ay: p.y1, bx: p.x2, by: p.y2 }))
}

/**
 * Filter walls to only those whose bounding box overlaps a circle (quick cull).
 */
export function cullWalls(
  walls: WallSegment[],
  cx: number, cy: number, radius: number,
): WallSegment[] {
  const r = radius * 1.1
  return walls.filter(w =>
    !(Math.max(w.ax, w.bx) < cx - r || Math.min(w.ax, w.bx) > cx + r ||
      Math.max(w.ay, w.by) < cy - r || Math.min(w.ay, w.by) > cy + r)
  )
}
