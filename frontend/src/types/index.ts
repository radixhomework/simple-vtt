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
  /** Legacy pre-floors columns — superseded by Floor, kept for older payloads */
  map_image_path?: string
  grid_size?: number
  uvt_metadata?: string
  map_offset_x?: number
  map_offset_y?: number
  /** getTable() embeds the floor list */
  floors?: Floor[]
  /** Caller's role on this map ('dm' | 'player'); listTables() includes it too */
  my_role?: 'dm' | 'player'
  /** Creator of the map (its first dm) */
  owner?: string
  /** Floor shown when loading the map ('' = lowest level) */
  default_floor_id?: string
  /** listTables() only */
  token_count?: number
  portal_count?: number
  floor_count?: number
  image_count?: number
}

/** Floor list entry (metadata only — no map data, so it stays lightweight). */
export interface FloorLite {
  id: string
  table_id: string
  level: number
  name: string
}

/** Full floor row — sent only for the viewer's active floor. */
export interface Floor extends FloorLite {
  map_image_path: string
  grid_size: number
  uvt_metadata: string
  map_offset_x: number
  map_offset_y: number
  img_width: number
  img_height: number
  /** Tile pyramid base URL ('' when the floor has no pyramid yet). */
  tiles_path?: string
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
  /** Floor the token is on */
  floor_id: string
}

/** Stairs: one-way link from a point on one floor to a point on another. */
export interface Stairs {
  id: string
  table_id: string
  from_floor: string
  from_x: number
  from_y: number
  to_floor: string
  to_x: number
  to_y: number
  radius: number
}

export interface FogPoint {
  id: string
  table_id: string
  x: number
  y: number
  radius: number
  floor_id?: string
}

export interface Camera {
  x: number
  y: number
  zoom: number
}

export type ToolType = 'select' | 'line' | 'circle' | 'square' | 'cone' | 'fog-erase' | 'fog-reveal' | 'stairs'

export interface WSMessage<T = unknown> {
  type: string
  payload: T
}

export interface TokenMovePayload {
  token_id: string
  x: number
  y: number
  /** Cross-floor move (stairs) */
  to_floor?: string
  to_x?: number
  to_y?: number
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
  floor_id: string
  /** door: blocks sight when closed; window: always transparent */
  kind: 'door' | 'window'
  /** Admin-only: players may never toggle a locked portal */
  locked: boolean
}

/** Someone invited to a map, with their role on it */
export interface MapMember {
  username: string
  role: 'dm' | 'player'
}

export interface TableStatePayload {
  table: { id: string; name: string }
  /** This client's role on the map */
  map_role: 'dm' | 'player'
  /** All floors (metadata only) + the active floor with its map data */
  floors: FloorLite[]
  floor: Floor | null
  tokens: Token[]
  fog: FogPoint[]
  portals: Portal[]
  stairs: Stairs[]
  settings: AppSettings
}

export interface ChatPayload {
  from: string
  message: string
}

/** Global, installation-wide settings (admin console Settings tab). */
export interface AppSettings {
  /** Maximum accepted size of a single asset upload, in megabytes */
  max_asset_size_mb: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  max_asset_size_mb: 50,
}

/** Per-map gameplay and display settings (admin-only edits, live-synced). */
export interface TableSettings {
  chat_enabled: boolean
  players_move_own_only: boolean
  players_open_doors: boolean
  players_open_windows: boolean
  snap_default: boolean
  fog_enabled_default: boolean
  grid_visible_default: boolean
  /** Real-world size of one grid square, in measurement_unit */
  grid_square_size: number
  measurement_unit: 'ft' | 'm'
}

export const DEFAULT_TABLE_SETTINGS: TableSettings = {
  chat_enabled: true,
  players_move_own_only: true,
  players_open_doors: true,
  players_open_windows: true,
  snap_default: true,
  fog_enabled_default: true,
  grid_visible_default: true,
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
