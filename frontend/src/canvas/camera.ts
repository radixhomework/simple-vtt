/**
 * Pure camera math: conversions between screen pixels and world units
 * (token/fog positions are stored in world space = pixels at zoom 1),
 * grid snapping and zoom anchored at a screen point.
 */
import type { Camera } from '../types'

export function screenToWorld(sx: number, sy: number, cam: Camera): [number, number] {
  return [(sx / cam.zoom) + cam.x, (sy / cam.zoom) + cam.y]
}

export function worldToScreen(wx: number, wy: number, cam: Camera): [number, number] {
  return [(wx - cam.x) * cam.zoom, (wy - cam.y) * cam.zoom]
}

export function snapToGrid(v: number, gridSize: number): number {
  return Math.round(v / gridSize) * gridSize
}

export function clampZoom(z: number): number {
  return Math.min(Math.max(z, 0.1), 8)
}

export function zoomAround(cam: Camera, screenX: number, screenY: number, delta: number): Camera {
  const factor = delta > 0 ? 1.1 : 0.909
  const newZoom = clampZoom(cam.zoom * factor)
  const zoomRatio = newZoom / cam.zoom
  const wx = (screenX / cam.zoom) + cam.x
  const wy = (screenY / cam.zoom) + cam.y
  return {
    x: wx - screenX / newZoom,
    y: wy - screenY / newZoom,
    zoom: newZoom,
  }
}
