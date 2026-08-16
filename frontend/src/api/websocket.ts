import type { WSMessage } from '../types'

type MessageHandler = (msg: WSMessage) => void

export class VTTSocket {
  private ws: WebSocket | null = null
  private handlers: Set<MessageHandler> = new Set()
  private tableId: string = ''
  private token: string = ''
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private dead = false

  connect(tableId: string, token: string) {
    this.tableId = tableId
    this.token = token
    this.dead = false
    this._connect()
  }

  private _connect() {
    if (this.dead) return
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${protocol}://${location.host}/ws?table=${this.tableId}&token=${this.token}`
    this.ws = new WebSocket(url)

    this.ws.onmessage = (e) => {
      try {
        const msg: WSMessage = JSON.parse(e.data)
        this.handlers.forEach(h => h(msg))
      } catch (_) {}
    }

    this.ws.onclose = () => {
      if (!this.dead) {
        this.reconnectTimer = setTimeout(() => this._connect(), 3000)
      }
    }

    this.ws.onerror = () => {
      this.ws?.close()
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this.ws = null
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN
  }
}

export const socket = new VTTSocket()
