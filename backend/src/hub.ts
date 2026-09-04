import { WebSocketServer, WebSocket } from 'ws'
import { IncomingMessage } from 'http'
import path from 'path'
import fs from 'fs'
import { verifyToken } from './auth'
import { db } from './db'
import { loadTableSettings } from './settings'
import { mapRole } from './mapaccess'
import { buildTilePyramid } from './tiles'

/**
 * WebSocket hub: rooms per table, message dispatch, and server-authoritative
 * state pushes (table_state, music_state, settings_update).
 *
 * Authorization model: `admin` may do anything; `player` may move/edit only
 * tokens they own (subject to the players_move_own_only setting) and use the
 * music transport. Everything else is admin-only and silently ignored.
 */

const uploadsDir = () => process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')

/**
 * Lazy tile backfill for floors imported before tiling existed: build the
 * pyramid in the background (once — the in-flight set dedupes), then push a
 * fresh table_state so connected clients switch to tiles. Any failure just
 * logs; the legacy full-image path keeps working.
 */
const pyramidsInProgress = new Set<string>()
function ensurePyramidAsync(floor: { id: string; map_image_path: string }): void {
  if (pyramidsInProgress.has(floor.id)) return
  pyramidsInProgress.add(floor.id)
  const file = path.join(uploadsDir(), path.basename(floor.map_image_path))
  fs.readFile(file, (err, buffer) => {
    if (err) {
      pyramidsInProgress.delete(floor.id)
      console.error(`[tiles] backfill read failed for floor ${floor.id}:`, err.message)
      return
    }
    buildTilePyramid(floor.id, buffer)
      .then(() => {
        db.prepare('UPDATE floors SET tiles_path=? WHERE id=?').run(`/uploads/tiles/${floor.id}`, floor.id)
        // Fresh state so connected clients see the new tiles_path (no-op
        // when nobody is in the room — the next join picks it up anyway)
        const tableId = (floor as { table_id?: string }).table_id
        if (tableId) pushTableStateToTable(tableId)
      })
      .catch(err2 => console.error(`[tiles] backfill failed for floor ${floor.id}:`, err2))
      .finally(() => pyramidsInProgress.delete(floor.id))
  })
}

/** Floor has usable dimensions (guards tiling on malformed metadata). */
function img_width_height_ok(floor: { img_width?: unknown; img_height?: unknown }): boolean {
  return typeof floor.img_width === 'number' && floor.img_width > 0
    && typeof floor.img_height === 'number' && floor.img_height > 0
}

/** WebSocket client connected to a table room. */
interface Client {
  ws: WebSocket
  username: string
  /** Global role (admin console rights) — NOT used for map permissions */
  role: string
  /** Role on THIS map: 'dm' or 'player' (membership-based; admins fall back
   *  to dm when uninvited). Governs everything done in the room. */
  mapRole: 'dm' | 'player'
  tableId: string
  /** Floor whose data this client currently views (null = not yet resolved). */
  activeFloorId: string | null
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

function broadcast(tableId: string, data: string, exclude?: Client, dmOnly = false) {
  tables.get(tableId)?.forEach(c => {
    if (c !== exclude && (!dmOnly || c.mapRole === 'dm') && c.ws.readyState === WebSocket.OPEN) {
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
      // Choosing a specific track is dm-only; everyone controls transport
      if (client.mapRole !== 'dm') break
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
    'SELECT id, name, default_floor_id FROM tables WHERE id=?'
  ).get(client.tableId) as { id: string; name: string; default_floor_id: string } | undefined

  if (!table) return

  // Floor list (metadata only) + the client's active floor. New connections
  // (or vanished floors) land on the configured default level, clamped to
  // the table's floor range.
  const floors = db.prepare(
    'SELECT id, table_id, level, name, revealed FROM floors WHERE table_id=? ORDER BY level, rowid'
  ).all(client.tableId) as Array<{ id: string; table_id: string; level: number; name: string }>
  const defaultFloor = floors.find(f => f.id === table.default_floor_id) ?? floors[0]
  const floorId = floors.some(f => f.id === client.activeFloorId) ? client.activeFloorId! : defaultFloor?.id ?? null
  client.activeFloorId = floorId
  const floor = floorId
    ? db.prepare(
        'SELECT id, table_id, level, name, map_image_path, grid_size, uvt_metadata, map_offset_x, map_offset_y, img_width, img_height, tiles_path, revealed FROM floors WHERE id=?'
      ).get(floorId) as {
        id: string; table_id: string; map_image_path: string; tiles_path: string
        img_width: number; img_height: number
      } | undefined
    : undefined

  // Lazy tile backfill: a floor with an image but no pyramid yet (imported
  // before tiling existed) gets one built in the background; the fresh
  // table_state after completion tells clients to switch to tiles.
  if (floor && floor.map_image_path && !floor.tiles_path && img_width_height_ok(floor)) {
    ensurePyramidAsync(floor as { id: string; map_image_path: string })
  }

  // Everything positional is scoped to the viewer's active floor — clients
  // never receive other levels' tokens, fog or doors.
  const tokenRows = db.prepare(
    'SELECT id, table_id, name, x, y, icon_path, has_vision, vision_radius, size, color, owner, hidden, floor_id FROM tokens WHERE table_id=? AND floor_id=?'
  ).all(client.tableId, floorId) as Array<Record<string, unknown>>

  // Hidden tokens (and their sight) are invisible to map players; dms keep
  // the full picture.
  const tokens = client.mapRole === 'dm'
    ? tokenRows.map(normalizeToken)
    : tokenRows.filter(t => t.hidden !== 1).map(normalizeToken)

  const fog = db.prepare(
    'SELECT id, table_id, x, y, radius, floor_id FROM fog_points WHERE table_id=? AND floor_id=?'
  ).all(client.tableId, floorId)

  const settings = loadTableSettings(client.tableId)

  const portalRows = db.prepare('SELECT id, table_id, x1, y1, x2, y2, closed, floor_id, kind, locked FROM portals WHERE table_id=? AND floor_id=?')
    .all(client.tableId, floorId) as Record<string, unknown>[]
  const portals = portalRows.map(p => ({ ...p, closed: p.closed === 1 }))

  const walls = db.prepare('SELECT id, table_id, floor_id, ax, ay, bx, by, group_id FROM walls WHERE table_id=? AND floor_id=?')
    .all(client.tableId, floorId)

  // Stairs leaving this floor (their counterparts show on the target floor)
  const stairs = db.prepare(
    'SELECT id, table_id, from_floor, from_x, from_y, to_floor, to_x, to_y, radius FROM stairs WHERE table_id=? AND from_floor=?'
  ).all(client.tableId, floorId)

  // Props on this floor (decorative assets; players see them too)
  const props = db.prepare(
    'SELECT id, table_id, floor_id, asset_path, name, x, y, size, rotation, z, opacity, group_id FROM props WHERE table_id=? AND floor_id=? ORDER BY z, rowid'
  ).all(client.tableId, floorId)

  send(client, {
    type: 'table_state',
    payload: {
      table,
      map_role: client.mapRole,
      floors,
      floor,
      tokens,
      fog,
      portals,
      walls,
      stairs,
      props,
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
      const { token_id, x, y, to_floor, to_x, to_y } = payload as {
        token_id: string; x: number; y: number; to_floor?: string; to_x?: number; to_y?: number
      }
      const tokenRow = db.prepare('SELECT owner, hidden FROM tokens WHERE id=? AND table_id=?')
        .get(token_id, client.tableId) as { owner: string; hidden: number } | undefined
      if (client.mapRole !== 'dm') {
        // Enforce players_move_own_only: map players may only move their own
        // tokens, unless the setting explicitly allows moving any token.
        const setting = db.prepare("SELECT value FROM settings WHERE key='players_move_own_only'")
          .get() as { value: string } | undefined
        const ownOnly = setting ? setting.value === 'true' : true
        if (!tokenRow || (ownOnly && tokenRow.owner !== client.username)) break
      }
      if (!tokenRow) break

      if (to_floor !== undefined) {
        // Cross-floor move (stairs): the token changes level. A full state
        // push resyncs every client — it leaves the floors some view and
        // arrives on another.
        const floor = db.prepare('SELECT id FROM floors WHERE id=? AND table_id=?')
          .get(to_floor, client.tableId) as { id: string } | undefined
        if (!floor) break
        db.prepare('UPDATE tokens SET x=?, y=?, floor_id=? WHERE id=? AND table_id=?')
          .run(to_x ?? x, to_y ?? y, to_floor, token_id, client.tableId)
        tables.get(client.tableId)?.forEach(c => sendTableState(c))
        break
      }

      db.prepare('UPDATE tokens SET x=?, y=? WHERE id=? AND table_id=?')
        .run(x, y, token_id, client.tableId)
      // Moves of hidden tokens are for admin eyes only
      broadcast(client.tableId, raw, client, tokenRow.hidden === 1)
      break
    }

    case 'token_update': {
      const t = (payload as { token: Record<string, unknown> }).token
      const existing = db.prepare(
        'SELECT name, x, y, icon_path, has_vision, vision_radius, size, color, owner, hidden, floor_id FROM tokens WHERE id=? AND table_id=?'
      ).get(t.id, client.tableId) as Record<string, unknown> | undefined
      if (!existing) break
      // Authorization: dms may edit anything; players only their own tokens,
      // and they cannot change owner/hidden (dm-only controls).
      const isOwner = existing.owner === client.username
      if (client.mapRole !== 'dm' && !isOwner) break
      const isAdmin = client.mapRole === 'dm'
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
        floor_id:      existing.floor_id,
      }
      // Floor change (token editor): target floor must belong to the table
      if (t.floor_id !== undefined && t.floor_id !== existing.floor_id) {
        const floor = db.prepare('SELECT id FROM floors WHERE id=? AND table_id=?')
          .get(t.floor_id, client.tableId) as { id: string } | undefined
        if (floor) m.floor_id = t.floor_id
      }
      const hiddenNow = m.hidden === 1 || m.hidden === true
      const wasHidden = existing.hidden === 1 || existing.hidden === true
      const floorChanged = m.floor_id !== existing.floor_id
      db.prepare(
        `UPDATE tokens SET name=?, x=?, y=?, icon_path=?, has_vision=?, vision_radius=?, size=?, color=?, owner=?, hidden=?, floor_id=?
         WHERE id=? AND table_id=?`
      ).run(m.name, m.x, m.y, m.icon_path, m.has_vision ? 1 : 0, m.vision_radius, m.size, m.color, m.owner, hiddenNow ? 1 : 0, m.floor_id, t.id, client.tableId)

      if (hiddenNow !== wasHidden || floorChanged) {
        // Visibility or floor changed: push a fresh table_state so players
        // gain/lose the token (and its sight) immediately.
        tables.get(client.tableId)?.forEach(c => sendTableState(c))
      } else {
        // Updates of hidden tokens are for admin eyes only; clients viewing
        // another floor never have this token in their state.
        tables.get(client.tableId)?.forEach(c => {
          if (c !== client && c.activeFloorId === m.floor_id && (!hiddenNow || c.role === 'admin') && c.ws.readyState === WebSocket.OPEN) {
            c.ws.send(raw)
          }
        })
      }
      break
    }

    case 'token_delete': {
      if (client.mapRole !== 'dm') return
      const { token_id } = payload as { token_id: string }
      db.prepare('DELETE FROM tokens WHERE id=? AND table_id=?').run(token_id, client.tableId)
      broadcast(client.tableId, raw, client)
      break
    }

    case 'fog_update': {
      if (client.mapRole !== 'dm') return
      const { action, points, floor_id } = payload as {
        action: string; points: Array<Record<string, unknown>>; floor_id?: string
      }
      // Fog is per floor: default to the client's viewed floor
      const floorId = floor_id ?? client.activeFloorId ?? ''
      if (action === 'clear_all') {
        // clear_all optionally carries the surviving points (used by the
        // erase tool: clear + re-add in one atomic step, no client flicker)
        db.prepare('DELETE FROM fog_points WHERE table_id=? AND floor_id=?').run(client.tableId, floorId)
        if (Array.isArray(points) && points.length > 0) {
          const insert = db.prepare('INSERT INTO fog_points (id, table_id, x, y, radius, floor_id) VALUES (?,?,?,?,?,?)')
          for (const p of points) {
            insert.run(newId(), client.tableId, p.x, p.y, p.radius ?? 3, floorId)
          }
        }
        // Authoritative resync for EVERY client of the table: the raw
        // per-floor broadcast only reaches viewers of that floor, so a
        // stale client (other floor, half-dead socket that missed the
        // message) would keep showing cleared fog.
        tables.get(client.tableId)?.forEach(c => sendTableState(c))
        break
      } else if (action === 'reset') {
        // Back to arrival state: no manual reveals, explored memory cleared,
        // any full-reveal flag removed. Clients wipe their local explored
        // bitmaps on the fog_reset notice.
        db.prepare('DELETE FROM fog_points WHERE table_id=? AND floor_id=?').run(client.tableId, floorId)
        db.prepare('UPDATE floors SET revealed=0 WHERE id=?').run(floorId)
        pushTableStateToTable(client.tableId)
        tables.get(client.tableId)?.forEach(c => {
          if (c !== client && c.ws.readyState === WebSocket.OPEN) {
            c.ws.send(JSON.stringify({ type: 'fog_reset', payload: { floor_id: floorId } }))
          }
        })
        break
      } else if (action === 'reveal_all') {
        // Remove ALL fog from the floor: marked fully revealed, manual
        // points wiped. New joiners get the flag via table_state.
        db.prepare('UPDATE floors SET revealed=1 WHERE id=?').run(floorId)
        db.prepare('DELETE FROM fog_points WHERE table_id=? AND floor_id=?').run(client.tableId, floorId)
        pushTableStateToTable(client.tableId)
        tables.get(client.tableId)?.forEach(c => {
          if (c !== client && c.ws.readyState === WebSocket.OPEN) {
            c.ws.send(JSON.stringify({ type: 'fog_revealed', payload: { floor_id: floorId } }))
          }
        })
        break
      } else if (action === 'add' && Array.isArray(points)) {
        // Keep client-generated ids: brush strokes then erase by id
        // incrementally instead of resending the whole survivors array
        const insert = db.prepare('INSERT OR IGNORE INTO fog_points (id, table_id, x, y, radius, floor_id) VALUES (?,?,?,?,?,?)')
        for (const p of points) {
          insert.run(typeof p.id === 'string' && p.id ? p.id : newId(), client.tableId, p.x, p.y, p.radius ?? 3, floorId)
        }
      } else if (action === 'remove_ids' && Array.isArray(payload.ids)) {
        const ids = (payload.ids as unknown[]).filter((x): x is string => typeof x === 'string')
        if (ids.length > 0) {
          const del = db.prepare('DELETE FROM fog_points WHERE table_id=? AND id=?')
          for (const id of ids) del.run(client.tableId, id)
        }
      }
      // Only viewers of that floor care; others ignore the points (their
      // state never includes the floor). Exclude the sender: it already
      // applied the change optimistically.
      tables.get(client.tableId)?.forEach(c => {
        if (c !== client && c.activeFloorId === floorId && c.ws.readyState === WebSocket.OPEN) c.ws.send(raw)
      })
      break
    }

    case 'floor_select': {
      // Viewer switched to another floor of the table
      const { floor_id } = payload as { floor_id: string }
      const floor = db.prepare('SELECT id FROM floors WHERE id=? AND table_id=?')
        .get(floor_id, client.tableId) as { id: string } | undefined
      if (floor) {
        client.activeFloorId = floor_id
        sendTableState(client)
      }
      break
    }

    case 'camera_focus': {
      // DM one-time focus: snap every other client's display (floor,
      // camera, zoom) to the dm's current view. Not a continuous follow.
      if (client.mapRole !== 'dm') return
      const { x, y, zoom, floor_id } = payload as { x: number; y: number; zoom: number; floor_id?: string }
      if (typeof x !== 'number' || typeof y !== 'number' || typeof zoom !== 'number') return
      const data = JSON.stringify({ type: 'camera_focus', payload: { x, y, zoom, floor_id } })
      tables.get(client.tableId)?.forEach(c => {
        if (c !== client && c.ws.readyState === WebSocket.OPEN) c.ws.send(data)
      })
      break
    }

    case 'measure_update': {
      // DM-only: broadcast the dm's measurement to the other clients
      if (client.mapRole !== 'dm') return
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

    // Map access: members only (uninvited global admins still resolve to dm)
    const role = mapRole(payload.username, tableId, payload.role)
    if (!role) { ws.close(1008, 'no access to this map'); return }

    const client: Client = { ws, username: payload.username, role: payload.role, mapRole: role, tableId, activeFloorId: null }
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
