import { WebSocketServer, WebSocket } from 'ws'
import { IncomingMessage } from 'http'
import { verifyToken } from './auth'
import { db } from './db'
import { loadSettings } from './settings'

/**
 * WebSocket hub: rooms per table, message dispatch, and server-authoritative
 * state pushes (table_state, music_state, settings_update).
 *
 * Authorization model: `admin` may do anything; `player` may move/edit only
 * tokens they own (subject to the players_move_own_only setting) and use the
 * music transport. Everything else is admin-only and silently ignored.
 */

/** WebSocket client connected to a table room. */
interface Client {
  ws: WebSocket
  username: string
  role: string
  tableId: string
}

// tableId → set of clients
const tables = new Map<string, Set<Client>>()

function register(client: Client) {
  if (!tables.has(client.tableId)) tables.set(client.tableId, new Set())
  tables.get(client.tableId)!.add(client)
}

function unregister(client: Client) {
  tables.get(client.tableId)?.delete(client)
}

function broadcast(tableId: string, data: string, exclude?: Client, adminOnly = false) {
  tables.get(tableId)?.forEach(c => {
    if (c !== exclude && (!adminOnly || c.role === 'admin') && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(data)
    }
  })
}

export function broadcastToTable(tableId: string, msg: object) {
  broadcast(tableId, JSON.stringify(msg))
}

export function broadcastToAll(msg: object) {
  const data = JSON.stringify(msg)
  tables.forEach(clients => {
    clients.forEach(c => {
      if (c.ws.readyState === WebSocket.OPEN) c.ws.send(data)
    })
  })
}

function send(client: Client, msg: object) {
  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(msg))
  }
}

/**
 * Push a fresh table_state to every client connected to a table. Used by
 * REST handlers after mutations that change what players are allowed to
 * see (e.g. token visibility).
 */
export function pushTableStateToTable(tableId: string) {
  tables.get(tableId)?.forEach(c => sendTableState(c))
}

// ── Music ─────────────────────────────────────────────────────────────────────
// Server-authoritative playback state per table. `position` is the track
// position in seconds at `updatedAt` (ms); clients derive the live position.

interface MusicState {
  current: string | null
  playing: boolean
  position: number
  updatedAt: number
  queue: string[]
}

const musicStates = new Map<string, MusicState>()

/** Audio library (shared assets). Order = upload order (rowid). */
function musicTracks(): Array<{ id: string; name: string; path: string }> {
  return db.prepare("SELECT id, name, path FROM assets WHERE kind='audio' ORDER BY rowid").all() as Array<{ id: string; name: string; path: string }>
}

function getMusicState(tableId: string): MusicState {
  let st = musicStates.get(tableId)
  if (!st) {
    st = { current: null, playing: false, position: 0, updatedAt: Date.now(), queue: musicTracks().map(t => t.id) }
    musicStates.set(tableId, st)
  }
  return st
}

function musicStatePayload(st: MusicState) {
  return {
    current: st.current,
    playing: st.playing,
    position: st.position,
    updatedAt: st.updatedAt,
    queue: st.queue,
    tracks: musicTracks(),
  }
}

function pushMusicState(tableId: string) {
  broadcast(tableId, JSON.stringify({ type: 'music_state', payload: musicStatePayload(getMusicState(tableId)) }))
}

/** Rebuild each table's queue after the audio library changes (upload/delete). */
export function musicLibraryChanged() {
  const tracks = musicTracks()
  const ids = new Set(tracks.map(t => t.id))
  tables.forEach((_clients, tableId) => {
    const st = getMusicState(tableId)
    st.queue = st.queue.filter(id => ids.has(id))
    for (const id of ids) if (!st.queue.includes(id)) st.queue.push(id)
    if (st.current && !ids.has(st.current)) {
      st.current = null
      st.playing = false
      st.position = 0
      st.updatedAt = Date.now()
    }
    pushMusicState(tableId)
  })
}

function handleMusicControl(client: Client, payload: Record<string, unknown>) {
  const { action, trackId, dir } = payload as { action: string; trackId?: string; dir?: number }
  const st = getMusicState(client.tableId)
  const now = Date.now()
  // Live position at the time of the command
  const pos = () => (st.playing ? st.position + (now - st.updatedAt) / 1000 : st.position)
  const startTrack = (id: string) => { st.current = id; st.position = 0; st.playing = true; st.updatedAt = now }

  switch (action) {
    case 'play':
      if (!st.current && st.queue.length > 0) startTrack(st.queue[0])
      else { st.position = pos(); st.playing = true; st.updatedAt = now }
      break
    case 'pause':
      st.position = pos(); st.playing = false; st.updatedAt = now
      break
    case 'next':
    case 'prev': {
      if (st.queue.length === 0) break
      const idx = st.current ? st.queue.indexOf(st.current) : -1
      const delta = action === 'next' ? 1 : -1
      startTrack(st.queue[idx === -1 ? 0 : (idx + delta + st.queue.length) % st.queue.length])
      break
    }
    case 'select':
      // Choosing a specific track is admin-only; everyone controls transport
      if (client.role !== 'admin') break
      if (trackId && st.queue.includes(trackId)) startTrack(trackId)
      break
    case 'ended':
      // Auto-advance when a track finishes; guarded so only the first
      // client's "ended" event switches tracks (others are ignored).
      if (!trackId || st.current !== trackId) break
      if (st.queue.length === 0) break
      startTrack(st.queue[(st.queue.indexOf(trackId) + 1) % st.queue.length])
      break
    case 'move': {
      // Reorder the queue (any user)
      if (!trackId || dir === undefined) break
      const i = st.queue.indexOf(trackId)
      const j = i + dir
      if (i === -1 || j < 0 || j >= st.queue.length) break
      ;[st.queue[i], st.queue[j]] = [st.queue[j], st.queue[i]]
      break
    }
  }
  pushMusicState(client.tableId)
}

function newId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16)
}

function sendTableState(client: Client) {
  const table = db.prepare(
    'SELECT id, name, map_image_path, grid_size, uvt_metadata, map_offset_x, map_offset_y FROM tables WHERE id=?'
  ).get(client.tableId) as Record<string, unknown> | undefined

  if (!table) return

  const tokenRows = db.prepare(
    'SELECT id, table_id, name, x, y, icon_path, has_vision, vision_radius, size, color, owner, hidden FROM tokens WHERE table_id=?'
  ).all(client.tableId) as Array<Record<string, unknown>>

  // Hidden tokens (and their sight) are invisible to players; admins keep
  // the full picture.
  const tokens = client.role === 'admin'
    ? tokenRows.map(normalizeToken)
    : tokenRows.filter(t => t.hidden !== 1).map(normalizeToken)

  const fog = db.prepare(
    'SELECT id, table_id, x, y, radius FROM fog_points WHERE table_id=?'
  ).all(client.tableId)

  const settings = loadSettings()

  const portalRows = db.prepare('SELECT id, table_id, x1, y1, x2, y2, closed FROM portals WHERE table_id=?')
    .all(client.tableId) as Record<string, unknown>[]
  const portals = portalRows.map(p => ({ ...p, closed: p.closed === 1 }))

  send(client, {
    type: 'table_state',
    payload: {
      table,
      tokens,
      fog,
      portals,
      settings,
    },
  })
}

function normalizeToken(row: Record<string, unknown>) {
  return {
    ...row,
    has_vision: row.has_vision === 1 || row.has_vision === true,
    hidden: row.hidden === 1 || row.hidden === true,
  }
}

function handleMessage(client: Client, raw: string) {
  let msg: { type: string; payload: Record<string, unknown> }
  try { msg = JSON.parse(raw) } catch { return }

  const { type, payload } = msg

  switch (type) {
    case 'token_move': {
      const { token_id, x, y } = payload as { token_id: string; x: number; y: number }
      const tokenRow = db.prepare('SELECT owner, hidden FROM tokens WHERE id=? AND table_id=?')
        .get(token_id, client.tableId) as { owner: string; hidden: number } | undefined
      if (client.role !== 'admin') {
        // Enforce players_move_own_only: non-admins may only move their own
        // tokens, unless the setting explicitly allows moving any token.
        const setting = db.prepare("SELECT value FROM settings WHERE key='players_move_own_only'")
          .get() as { value: string } | undefined
        const ownOnly = setting ? setting.value === 'true' : true
        if (!tokenRow || (ownOnly && tokenRow.owner !== client.username)) break
      }
      if (!tokenRow) break
      db.prepare('UPDATE tokens SET x=?, y=? WHERE id=? AND table_id=?')
        .run(x, y, token_id, client.tableId)
      // Moves of hidden tokens are for admin eyes only
      broadcast(client.tableId, raw, client, tokenRow.hidden === 1)
      break
    }

    case 'token_update': {
      const t = (payload as { token: Record<string, unknown> }).token
      const existing = db.prepare(
        'SELECT name, x, y, icon_path, has_vision, vision_radius, size, color, owner, hidden FROM tokens WHERE id=? AND table_id=?'
      ).get(t.id, client.tableId) as Record<string, unknown> | undefined
      if (!existing) break
      // Authorization: admins may edit anything; players only their own
      // tokens, and they cannot change owner/hidden (admin-only controls).
      const isOwner = existing.owner === client.username
      if (client.role !== 'admin' && !isOwner) break
      const isAdmin = client.role === 'admin'
      const m = {
        name:          t.name          !== undefined ? t.name          : existing.name,
        x:             t.x             !== undefined ? t.x             : existing.x,
        y:             t.y             !== undefined ? t.y             : existing.y,
        icon_path:     t.icon_path     !== undefined ? t.icon_path     : existing.icon_path,
        has_vision:    t.has_vision    !== undefined ? t.has_vision    : existing.has_vision,
        vision_radius: t.vision_radius !== undefined ? t.vision_radius : existing.vision_radius,
        size:          t.size          !== undefined ? t.size          : existing.size,
        color:         t.color         !== undefined ? t.color         : existing.color,
        owner:         isAdmin && t.owner !== undefined ? t.owner : existing.owner,
        hidden:        isAdmin && t.hidden !== undefined ? t.hidden : existing.hidden,
      }
      const hiddenNow = m.hidden === 1 || m.hidden === true
      const wasHidden = existing.hidden === 1 || existing.hidden === true
      db.prepare(
        `UPDATE tokens SET name=?, x=?, y=?, icon_path=?, has_vision=?, vision_radius=?, size=?, color=?, owner=?, hidden=?
         WHERE id=? AND table_id=?`
      ).run(m.name, m.x, m.y, m.icon_path, m.has_vision ? 1 : 0, m.vision_radius, m.size, m.color, m.owner, hiddenNow ? 1 : 0, t.id, client.tableId)

      if (hiddenNow !== wasHidden) {
        // Visibility changed: push a fresh table_state so players gain/lose
        // the token (and its sight) immediately.
        tables.get(client.tableId)?.forEach(c => sendTableState(c))
      } else {
        // Updates of hidden tokens are for admin eyes only
        broadcast(client.tableId, raw, client, hiddenNow)
      }
      break
    }

    case 'token_delete': {
      if (client.role !== 'admin') return
      const { token_id } = payload as { token_id: string }
      db.prepare('DELETE FROM tokens WHERE id=? AND table_id=?').run(token_id, client.tableId)
      broadcast(client.tableId, raw, client)
      break
    }

    case 'fog_update': {
      if (client.role !== 'admin') return
      const { action, points } = payload as { action: string; points: Array<Record<string, unknown>> }
      if (action === 'clear_all') {
        // clear_all optionally carries the surviving points (used by the
        // erase tool: clear + re-add in one atomic step, no client flicker)
        db.prepare('DELETE FROM fog_points WHERE table_id=?').run(client.tableId)
        if (Array.isArray(points) && points.length > 0) {
          const insert = db.prepare('INSERT INTO fog_points (id, table_id, x, y, radius) VALUES (?,?,?,?,?)')
          for (const p of points) {
            insert.run(newId(), client.tableId, p.x, p.y, p.radius ?? 3)
          }
        }
      } else if (action === 'add' && Array.isArray(points)) {
        const insert = db.prepare('INSERT INTO fog_points (id, table_id, x, y, radius) VALUES (?,?,?,?,?)')
        for (const p of points) {
          insert.run(newId(), client.tableId, p.x, p.y, p.radius ?? 3)
        }
      }
      // Exclude the sender: it already applied the change optimistically,
      // receiving it back would duplicate points in its local state.
      broadcast(client.tableId, raw, client)
      break
    }

    case 'measure_update': {
      // Admin-only: broadcast the admin's measurement to the other clients
      if (client.role !== 'admin') return
      broadcast(client.tableId, raw, client)
      break
    }

    case 'music_control':
      handleMusicControl(client, payload)
      break

    case 'chat':
      broadcast(client.tableId, raw, client)
      break

    case 'ping':
      send(client, { type: 'pong', payload: {} })
      break
  }
}

export function setupWebSocket(wss: WebSocketServer) {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    const tableId = url.searchParams.get('table') ?? ''
    const tokenStr = url.searchParams.get('token') ?? ''

    if (!tableId || !tokenStr) { ws.close(1008, 'missing params'); return }

    const payload = verifyToken(tokenStr)
    if (!payload) { ws.close(1008, 'invalid token'); return }

    // Check table exists
    const tableExists = db.prepare('SELECT id FROM tables WHERE id=?').get(tableId)
    if (!tableExists) { ws.close(1008, 'table not found'); return }

    const client: Client = { ws, username: payload.username, role: payload.role, tableId }
    register(client)
    sendTableState(client)
    send(client, { type: 'music_state', payload: musicStatePayload(getMusicState(tableId)) })

    ws.on('message', (data) => handleMessage(client, data.toString()))
    ws.on('close', () => unregister(client))
    ws.on('error', () => { unregister(client); ws.close() })

    // Ping every 30s
    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping()
      else clearInterval(ping)
    }, 30_000)
    ws.on('close', () => clearInterval(ping))
  })
}
