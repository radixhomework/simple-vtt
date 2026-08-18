/**
 * Single-table WebSocket client. Auto-reconnects every 3 s while the page
 * stays open; connect() supersedes any previous connection (stale sockets
 * are detached and can neither deliver messages nor trigger reconnects).
 */
import type { WSMessage } from '../types'

type MessageHandler = (msg: WSMessage) => void

export class VTTSocket {
  private ws: WebSocket | null = null
  private handlers: Set<MessageHandler> = new Set()
  private tableId: string = ''
  private token: string = ''
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private dead = true

  connect(tableId: string, token: string) {
    // A fresh connect always supersedes any previous/pending connection:
    // cancel a scheduled reconnect and detach the old socket without
    // triggering its onclose reconnect logic.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.onclose = null
      this.ws.onmessage = null
      this.ws.onerror = null
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close()
      }
      this.ws = null
    }

    this.tableId = tableId
    this.token = token
    this.dead = false
    this._connect()
  }

  private _connect() {
    if (this.dead) return
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${protocol}://${location.host}/ws?table=${this.tableId}&token=${this.token}`
    const ws = new WebSocket(url)
    this.ws = ws

    ws.onmessage = (e) => {
      if (ws !== this.ws) return // stale socket from a previous connect
      try {
        const msg: WSMessage = JSON.parse(e.data)
        this.handlers.forEach(h => h(msg))
      } catch (_) {}
    }

    ws.onclose = () => {
      if (ws !== this.ws) return
      if (!this.dead) {
        this.reconnectTimer = setTimeout(() => this._connect(), 3000)
      }
    }

    ws.onerror = () => {
      ws.close()
    }
  }

  send(type: string, payload: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, payload }))
    }
  }

  on(handler: MessageHandler) {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  disconnect() {
    this.dead = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.onclose = null
      this.ws.onmessage = null
      this.ws.onerror = null
      this.ws.close()
      this.ws = null
    }
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN
  }
}

export const socket = new VTTSocket()
