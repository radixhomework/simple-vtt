/**
 * Line-of-sight worker: computes visibility polygons off the main thread.
 *
 * The wall set is shipped once per wall change (version-tagged); compute
 * requests then carry only token coordinates. Results flow back tagged
 * with the request key, so the main thread can drop answers that arrive
 * after a newer position (drags generate a burst of requests).
 *
 * Same module as the main thread uses (./los) — one implementation, no
 * algorithm drift.
 */
import { cullWalls, computeVisibilityPolygon } from './los'
import type { WallSegment, Point } from './los'

let walls: WallSegment[] = []
let version = -1

export interface LosRequest {
  type: 'compute'
  key: string
  version: number
  ox: number
  oy: number
  radius: number
}
export interface LosWalls {
  type: 'walls'
  version: number
  walls: WallSegment[]
}
export interface LosResponse {
  key: string
  version: number
  poly: Point[] | null
}
export type LosInbound = LosRequest | LosWalls

self.onmessage = (e: MessageEvent<LosInbound>) => {
  const msg = e.data
  if (msg.type === 'walls') {
    walls = msg.walls
    version = msg.version
    return
  }
  if (msg.type === 'compute') {
    if (msg.version !== version) return // stale: a wall change superseded it
    const nearby = cullWalls(walls, msg.ox, msg.oy, msg.radius)
    const poly = nearby.length > 0 ? computeVisibilityPolygon(msg.ox, msg.oy, msg.radius, nearby) : null
    const res: LosResponse = { key: msg.key, version: msg.version, poly }
    ;(self as unknown as Worker).postMessage(res)
  }
}
