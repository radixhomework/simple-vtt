import type { Table, Token, User, FogPoint, AppSettings, Portal, MusicTrack } from '../types'

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

  // Users
  listUsers: () => request<User[]>('GET', '/users'),
  createUser: (username: string, password: string, role: string) =>
    request<User>('POST', '/users', { username, password, role }),
  deleteUser: (username: string) => request<void>('DELETE', `/users/${username}`),

  // Tables
  listTables: () => request<Table[]>('GET', '/tables'),
  createTable: (name: string, gridSize?: number) =>
    request<Table>('POST', '/tables', { name, grid_size: gridSize ?? 70 }),
  getTable: (id: string) => request<Table>('GET', `/tables/${id}`),
  updateTable: (id: string, data: Partial<Table>) =>
    request<Table>('PUT', `/tables/${id}`, data),
  deleteTable: (id: string) => request<void>('DELETE', `/tables/${id}`),

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
  clearFog: (tableId: string) => request<void>('DELETE', `/tables/${tableId}/fog`),

  // Settings
  getSettings: () => request<AppSettings>('GET', '/settings'),
  patchSettings: (updates: Partial<AppSettings>) => request<AppSettings>('PATCH', '/settings', updates),

  // Portals
  listPortals: (tableId: string) => request<Portal[]>('GET', `/tables/${tableId}/portals`),
  togglePortal: (tableId: string, portalId: string, closed: boolean) =>
    request<Portal>('PATCH', `/tables/${tableId}/portals/${portalId}`, { closed }),

  // Music
  listMusic: () => request<MusicTrack[]>('GET', '/music'),
  deleteMusic: (id: string) => request<void>('DELETE', `/music/${id}`),

  async uploadMusic(file: File): Promise<MusicTrack> {
    const fd = new FormData()
    fd.append('music', file)
    const res = await fetch(BASE + '/music', {
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
