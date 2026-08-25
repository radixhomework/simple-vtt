/**
 * Typed REST client. The JWT is read from localStorage on every call;
 * multipart uploads (maps, music, icons) use their own fetch helpers.
 */
import type { Table, Token, User, FogPoint, AppSettings, TableSettings, Portal, Asset, Floor, Stairs, MapMember } from '../types'

const BASE = '/api'

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('token')
  return token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: authHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${method} ${path}: ${res.status} ${text}`)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

export const api = {
  // Auth
  login: (username: string, password: string) =>
    request<{ token: string; user: User }>('POST', '/auth/login', { username, password }),

  me: () => request<User>('GET', '/me'),

  getVersion: () => request<{ version: string; name: string }>('GET', '/version'),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>('POST', '/auth/password', { current_password: currentPassword, new_password: newPassword }),

  // Users
  listUsers: () => request<User[]>('GET', '/users'),
  createUser: (username: string, password: string, role: string) =>
    request<User>('POST', '/users', { username, password, role }),
  deleteUser: (username: string) => request<void>('DELETE', `/users/${username}`),
  updateUserRole: (username: string, role: string) =>
    request<User>('PUT', `/users/${username}`, { role }),
  resetUserPassword: (username: string, newPassword: string) =>
    request<{ ok: boolean }>('POST', `/users/${username}/password`, { new_password: newPassword }),

  // Tables
  listTables: () => request<Table[]>('GET', '/tables'),
  createTable: (name: string, gridSize?: number) =>
    request<Table>('POST', '/tables', { name, grid_size: gridSize ?? 70 }),
  getTable: (id: string) => request<Table>('GET', `/tables/${id}`),
  updateTable: (id: string, data: Partial<Table>) =>
    request<Table>('PUT', `/tables/${id}`, data),
  listMembers: (tableId: string) => request<MapMember[]>('GET', `/tables/${tableId}/members`),
  addMember: (tableId: string, username: string, role: 'dm' | 'player') =>
    request<MapMember>('POST', `/tables/${tableId}/members`, { username, role }),
  removeMember: (tableId: string, username: string) =>
    request<void>('DELETE', `/tables/${tableId}/members/${username}`),
  deleteTable: (id: string) => request<void>('DELETE', `/tables/${id}`),

  // Floors (levels) of a table
  createFloor: (tableId: string, data: { name?: string; grid_size?: number }) =>
    request<Floor>('POST', `/tables/${tableId}/floors`, data),
  updateFloor: (floorId: string, data: Partial<Floor>) =>
    request<Floor>('PUT', `/floors/${floorId}`, data),
  reorderFloors: (tableId: string, floorIds: string[]) =>
    request<Floor[]>('PUT', `/tables/${tableId}/floors/reorder`, { floor_ids: floorIds }),
  deleteFloor: (floorId: string) => request<void>('DELETE', `/floors/${floorId}`),
  async importFloorUVTT(tableId: string, file: File, name?: string): Promise<Floor> {
    const fd = new FormData()
    fd.append('file', file)
    if (name) fd.append('name', name)
    const res = await fetch(BASE + `/tables/${tableId}/floors/import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${localStorage.getItem('token') ?? ''}` },
      body: fd,
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },
  async uploadFloorImage(floorId: string, file: File, width: number, height: number): Promise<{ path: string }> {
    // Measure the image client-side for the server's dimension check
    const fd = new FormData()
    fd.append('image', file)
    fd.append('width', String(width))
    fd.append('height', String(height))
    const res = await fetch(BASE + `/floors/${floorId}/upload-image`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${localStorage.getItem('token') ?? ''}` },
      body: fd,
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  // Stairs between floors
  createStair: (tableId: string, data: Omit<Stairs, 'id' | 'table_id'>) =>
    request<Stairs>('POST', `/tables/${tableId}/stairs`, data),
  deleteStair: (id: string) => request<void>('DELETE', `/stairs/${id}`),
  updateStair: (tableId: string, stairId: string, data: { to_floor: string }) =>
    request<Stairs>('PATCH', `/tables/${tableId}/stairs/${stairId}`, data),

  // Tokens
  listTokens: (tableId: string) => request<Token[]>('GET', `/tables/${tableId}/tokens`),
  createToken: (tableId: string, token: Partial<Token>) =>
    request<Token>('POST', `/tables/${tableId}/tokens`, token),
  updateToken: (tableId: string, tokenId: string, token: Partial<Token>) =>
    request<Token>('PUT', `/tables/${tableId}/tokens/${tokenId}`, token),
  deleteToken: (tableId: string, tokenId: string) =>
    request<void>('DELETE', `/tables/${tableId}/tokens/${tokenId}`),

  // Fog
  listFog: (tableId: string) => request<FogPoint[]>('GET', `/tables/${tableId}/fog`),
  clearFog: (tableId: string, floorId?: string) =>
    request<void>('DELETE', `/tables/${tableId}/fog${floorId ? `?floor_id=${floorId}` : ''}`),

  // Settings
  getSettings: () => request<AppSettings>('GET', '/settings'),
  getTableSettings: (tableId: string) => request<TableSettings>('GET', `/tables/${tableId}/settings`),
  patchTableSettings: (tableId: string, updates: Partial<TableSettings>) =>
    request<TableSettings>('PATCH', `/tables/${tableId}/settings`, updates),
  patchSettings: (updates: Partial<AppSettings>) => request<AppSettings>('PATCH', '/settings', updates),

  // Portals
  listPortals: (tableId: string) => request<Portal[]>('GET', `/tables/${tableId}/portals`),
  togglePortal: (tableId: string, portalId: string, closed: boolean) =>
    request<Portal>('PATCH', `/tables/${tableId}/portals/${portalId}`, { closed }),
  setPortalKind: (tableId: string, portalId: string, kind: 'door' | 'window') =>
    request<Portal>('PATCH', `/tables/${tableId}/portals/${portalId}`, { kind }),
  setPortalLocked: (tableId: string, portalId: string, locked: boolean) =>
    request<Portal>('PATCH', `/tables/${tableId}/portals/${portalId}`, { locked }),

  // Assets (shared image + audio library, deduplicated server-side)
  listAssets: (kind: 'image' | 'audio') => request<Asset[]>('GET', `/assets?kind=${kind}`),
  deleteAsset: (id: string) => request<void>('DELETE', `/assets/${id}`),
  updateAsset: (id: string, data: { folder?: string; name?: string }) => request<Asset>('PUT', `/assets/${id}`, data),

  async uploadAsset(file: File, kind: 'image' | 'audio'): Promise<Asset> {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('kind', kind)
    const res = await fetch(BASE + '/assets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${localStorage.getItem('token') ?? ''}` },
      body: fd,
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  // File uploads
  async importUVTT(file: File, name?: string): Promise<Table> {
    const fd = new FormData()
    fd.append('file', file)
    if (name) fd.append('name', name)
    const res = await fetch(BASE + '/tables/import', {
      method: 'POST',
      headers: { Authorization: `Bearer ${localStorage.getItem('token') ?? ''}` },
      body: fd,
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async uploadImage(tableId: string, file: File): Promise<{ path: string }> {
    const fd = new FormData()
    fd.append('image', file)
    const res = await fetch(BASE + `/tables/${tableId}/upload-image`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${localStorage.getItem('token') ?? ''}` },
      body: fd,
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async uploadTokenIcon(file: File): Promise<{ path: string }> {
    const fd = new FormData()
    fd.append('icon', file)
    const res = await fetch(BASE + '/upload-token-icon', {
      method: 'POST',
      headers: { Authorization: `Bearer ${localStorage.getItem('token') ?? ''}` },
      body: fd,
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },
}
