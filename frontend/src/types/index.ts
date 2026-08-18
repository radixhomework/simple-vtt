/**
 * Shared frontend types: mirrors of the backend DB rows and WebSocket
 * payloads, plus client-only state (Camera, ToolType, MeasureState).
 */
export interface User {
  username: string
  role: 'admin' | 'player'
}

export interface Table {
  id: string
  name: string
  map_image_path: string
  grid_size: number
  uvt_metadata?: string
  map_offset_x: number
  map_offset_y: number
  /** listTables() only */
  token_count?: number
  portal_count?: number
}

export interface Token {
  id: string
  table_id: string
  name: string
  x: number
  y: number
  icon_path: string
  has_vision: boolean
  vision_radius: number
  size: number
  color: string
  owner: string
  /** Admin-only: hidden tokens (and their sight) are invisible to players */
  hidden: boolean
}

export interface FogPoint {
  id: string
  table_id: string
  x: number
  y: number
  radius: number
}

export interface Camera {
  x: number
  y: number
  zoom: number
}

export type ToolType = 'select' | 'line' | 'circle' | 'square' | 'cone' | 'fog-erase' | 'fog-reveal'

export interface WSMessage<T = unknown> {
  type: string
  payload: T
}

export interface TokenMovePayload {
  token_id: string
  x: number
  y: number
}

export interface TokenUpdatePayload {
  token: Token
}

export interface TokenDeletePayload {
  token_id: string
}

export interface FogUpdatePayload {
  action: 'add' | 'clear_all'
  points: FogPoint[]
}

export interface Portal {
  id: string
  table_id: string
  x1: number
  y1: number
  x2: number
  y2: number
  closed: boolean
}

export interface TableStatePayload {
  table: Table
  tokens: Token[]
  fog: FogPoint[]
  portals: Portal[]
  settings: AppSettings
}

export interface ChatPayload {
  from: string
  message: string
}

export interface AppSettings {
  chat_enabled: boolean
  players_move_own_only: boolean
  fog_enabled_default: boolean
  grid_visible_default: boolean
  snap_default: boolean
  /** Real-world size of one grid square, in measurement_unit */
  grid_square_size: number
  measurement_unit: 'ft' | 'm'
}

export const DEFAULT_SETTINGS: AppSettings = {
  chat_enabled: true,
  players_move_own_only: true,
  fog_enabled_default: true,
  grid_visible_default: true,
  snap_default: true,
  grid_square_size: 5,
  measurement_unit: 'ft',
}

export interface MeasureState {
  active: boolean
  /** Keep the measurement drawn after the drag ends (shared measurements) */
  persist?: boolean
  tool: ToolType
  startX: number
  startY: number
  endX: number
  endY: number
}

/** Admin broadcasts its measurement to every client on the table */
export interface MeasureUpdatePayload {
  measure: MeasureState | null
}

/** Music library track */
export interface MusicTrack {
  id: string
  name: string
  path: string
}

/** Shared library asset (token images, music tracks) — deduplicated by content */
export interface Asset {
  id: string
  kind: 'image' | 'audio'
  name: string
  path: string
  size: number
  /** Organizational folder ('' = root) */
  folder: string
  /** true when an upload returned an existing asset instead of creating one */
  existing?: boolean
}

/** Server-authoritative music playback state, synced to every client */
export interface MusicStatePayload {
  current: string | null
  playing: boolean
  /** Track position in seconds at `updatedAt` (ms epoch) */
  position: number
  updatedAt: number
  queue: string[]
  tracks: MusicTrack[]
}
