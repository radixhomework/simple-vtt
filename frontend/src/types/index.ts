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
}

export const DEFAULT_SETTINGS: AppSettings = {
  chat_enabled: true,
  players_move_own_only: true,
  fog_enabled_default: true,
  grid_visible_default: true,
}

export interface MeasureState {
  active: boolean
  tool: ToolType
  startX: number
  startY: number
  endX: number
  endY: number
}
