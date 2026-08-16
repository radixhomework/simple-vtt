import { WebSocketServer, WebSocket } from 'ws'
import { IncomingMessage } from 'http'
import { verifyToken } from './auth'
import { db } from './db'

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

function broadcast(tableId: string, data: string, exclude?: Client) {
  tables.get(tableId)?.forEach(c => {
    if (c !== exclude && c.ws.readyState === WebSocket.OPEN) {
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

function newId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16)
}

function sendTableState(client: Client) {
  const table = db.prepare(
    'SELECT id, name, map_image_path, grid_size, uvt_metadata, map_offset_x, map_offset_y, tokens_hidden FROM tables WHERE id=?'
  ).get(client.tableId) as Record<string, unknown> | undefined

  if (!table) return

  const tokens = db.prepare(
    'SELECT id, table_id, name, x, y, icon_path, has_vision, vision_radius, size, color, owner FROM tokens WHERE table_id=?'
  ).all(client.tableId)

  const fog = db.prepare(
    'SELECT id, table_id, x, y, radius FROM fog_points WHERE table_id=?'
  ).all(client.tableId)

  const settingRows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  const settings = Object.fromEntries(settingRows.map(r => [r.key, r.value === 'true']))

  const portalRows = db.prepare('SELECT id, table_id, x1, y1, x2, y2, closed FROM portals WHERE table_id=?')
    .all(client.tableId) as Record<string, unknown>[]
  const portals = portalRows.map(p => ({ ...p, closed: p.closed === 1 }))

  send(client, {
    type: 'table_state',
    payload: {
      table: { ...table, tokens_hidden: table.tokens_hidden === 1, has_vision: undefined },
      tokens: (tokens as Record<string, unknown>[]).map(normalizeToken),
      fog,
      portals,
      settings,
    },
  })
}

function normalizeToken(row: Record<string, unknown>) {
  return { ...row, has_vision: row.has_vision === 1 || row.has_vision === true }
}

function handleMessage(client: Client, raw: string) {
  let msg: { type: string; payload: Record<string, unknown> }
  try { msg = JSON.parse(raw) } catch { return }

  const { type, payload } = msg

  switch (type) {
    case 'token_move': {
      const { token_id, x, y } = payload as { token_id: string; x: number; y: number }
      if (client.role !== 'admin') {
        // Enforce players_move_own_only: non-admins may only move their own
        // tokens, unless the setting explicitly allows moving any token.
        const token = db.prepare('SELECT owner FROM tokens WHERE id=? AND table_id=?')
          .get(token_id, client.tableId) as { owner: string } | undefined
        const setting = db.prepare("SELECT value FROM settings WHERE key='players_move_own_only'")
          .get() as { value: string } | undefined
        const ownOnly = setting ? setting.value === 'true' : true
        if (!token || (ownOnly && token.owner !== client.username)) break
      }
      db.prepare('UPDATE tokens SET x=?, y=? WHERE id=? AND table_id=?')
        .run(x, y, token_id, client.tableId)
      broadcast(client.tableId, raw, client)
      break
    }

    case 'token_update': {
      const t = (payload as { token: Record<string, unknown> }).token
      const existing = db.prepare(
        'SELECT name, x, y, icon_path, has_vision, vision_radius, size, color, owner FROM tokens WHERE id=? AND table_id=?'
      ).get(t.id, client.tableId) as Record<string, unknown> | undefined
      if (!existing) break
      const m = {
        name:          t.name          !== undefined ? t.name          : existing.name,
        x:             t.x             !== undefined ? t.x             : existing.x,
        y:             t.y             !== undefined ? t.y             : existing.y,
        icon_path:     t.icon_path     !== undefined ? t.icon_path     : existing.icon_path,
        has_vision:    t.has_vision    !== undefined ? t.has_vision    : existing.has_vision,
        vision_radius: t.vision_radius !== undefined ? t.vision_radius : existing.vision_radius,
        size:          t.size          !== undefined ? t.size          : existing.size,
        color:         t.color         !== undefined ? t.color         : existing.color,
        owner:         t.owner         !== undefined ? t.owner         : existing.owner,
      }
      db.prepare(
        `UPDATE tokens SET name=?, x=?, y=?, icon_path=?, has_vision=?, vision_radius=?, size=?, color=?, owner=?
         WHERE id=? AND table_id=?`
      ).run(m.name, m.x, m.y, m.icon_path, m.has_vision ? 1 : 0, m.vision_radius, m.size, m.color, m.owner, t.id, client.tableId)
      broadcast(client.tableId, raw, client)
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
        db.prepare('DELETE FROM fog_points WHERE table_id=?').run(client.tableId)
      } else if (action === 'add' && Array.isArray(points)) {
        const insert = db.prepare('INSERT INTO fog_points (id, table_id, x, y, radius) VALUES (?,?,?,?,?)')
        for (const p of points) {
          insert.run(newId(), client.tableId, p.x, p.y, p.radius ?? 3)
        }
      }
      broadcast(client.tableId, raw)
      break
    }

    case 'measure_update': {
      // Admin-only: broadcast the admin's measurement to the other clients
      if (client.role !== 'admin') return
      broadcast(client.tableId, raw, client)
      break
    }

    case 'tokens_visible': {
      // Admin-only: show/hide tokens for everyone on the table; persisted so
      // late joiners inherit the state via table_state.
      if (client.role !== 'admin') return
      const { visible } = payload as { visible: boolean }
      db.prepare('UPDATE tables SET tokens_hidden=? WHERE id=?').run(visible ? 0 : 1, client.tableId)
      broadcast(client.tableId, raw) // include sender: its UI updates through the same path
      break
    }

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
