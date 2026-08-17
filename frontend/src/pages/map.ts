import { api } from '../api/client'
import { socket } from '../api/websocket'
import {
  drawMap, drawGrid, drawTokens, drawFog, drawPortals, drawMeasure,
  preloadTokenImage, preloadMapImage, updateExplored,
} from '../canvas/layers'
import { screenToWorld, worldToScreen, snapToGrid, zoomAround } from '../canvas/camera'
import { parseStaticWalls, portalWalls, pathCrossesWall, pointOnWall } from '../canvas/los'
import type { WallSegment } from '../canvas/los'
import type {
  User, Table, Token, FogPoint, Portal, Camera, ToolType, MeasureState, AppSettings,
  TableStatePayload, TokenMovePayload, TokenUpdatePayload, TokenDeletePayload, FogUpdatePayload,
  MeasureUpdatePayload, MusicStatePayload,
} from '../types'
import { DEFAULT_SETTINGS } from '../types'

interface GameState {
  table: Table
  tokens: Token[]
  fog: FogPoint[]
  portals: Portal[]
  walls: WallSegment[]
  settings: AppSettings
  camera: Camera
  mapImage: HTMLImageElement | null
  mapImagePath: string
  exploredCanvas: OffscreenCanvas | null
  selectedId: string | null
  tool: ToolType
  snap: boolean
  gridVisible: boolean
  fogEnabled: boolean
  zen: boolean
  measure: MeasureState
  sharedMeasure: MeasureState | null
  shareMeasure: boolean
  music: MusicStatePayload | null
  dragging: boolean
  dragOffX: number
  dragOffY: number
  dragStartX: number
  dragStartY: number
  panning: boolean
  panStartX: number
  panStartY: number
  panCamX: number
  panCamY: number
}

export function renderMap(
  root: HTMLElement,
  user: User,
  table: Table,
  onTeardown: (teardown: () => void) => void,
  onBack: () => void,
) {
  const isAdmin = user.role === 'admin'

  root.innerHTML = `
    <style>
      .game { display: flex; flex-direction: column; height: 100%; background: #000; overflow: hidden; }
      /* Fullscreen mode: hide every menu, keep only the canvases */
      .game.zen .game-header, .game.zen .chat-wrap, .game.zen .sidebar, .game.zen .music-panel { display: none; }

      /* Music panel (left side) */
      .music-panel {
        position: absolute; left: 0; top: 0; bottom: 0;
        width: 260px; background: #1a1a2e; border-right: 1px solid #2d2d4e;
        display: flex; flex-direction: column; z-index: 20; transform: translateX(-100%);
        transition: transform 0.2s; overflow-y: auto;
      }
      .music-panel.open { transform: none; }
      .music-row {
        display: flex; align-items: center; gap: 6px; padding: 6px 8px;
        border-radius: 6px; cursor: pointer; font-size: 13px; transition: background 0.15s;
      }
      .music-row:hover { background: #2d2d4e; }
      .music-row.current { background: #1e3a5f; }
      .music-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .game-header {
        display: flex; align-items: center; gap: 10px;
        padding: 0 12px; height: 44px; background: #1a1a2e;
        border-bottom: 1px solid #2d2d4e; flex-shrink: 0; z-index: 10;
        user-select: none;
      }
      .game-header-left { display: flex; align-items: center; gap: 8px; }
      .game-header-right { display: flex; align-items: center; gap: 8px; margin-left: auto; }
      .header-btn {
        padding: 5px 11px; border-radius: 6px; border: 1px solid #2d2d4e;
        background: transparent; color: #c0c0e0; font-size: 12px; cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
      }
      .header-btn:hover { background: #2d2d4e; }
      .header-btn.active { background: #4a90d9; border-color: #4a90d9; color: #fff; }
      .header-sep { width: 1px; height: 22px; background: #2d2d4e; }
      .table-name { font-size: 14px; font-weight: 600; color: #e0e0f0; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .canvas-wrap { flex: 1; position: relative; overflow: hidden; }
      canvas { position: absolute; top: 0; left: 0; cursor: crosshair; }
      #canvas-main { z-index: 1; }
      #canvas-fog  { z-index: 2; pointer-events: none; }
      #canvas-ui   { z-index: 3; }

      /* Sidebar */
      .sidebar {
        position: absolute; right: 0; top: 0; bottom: 0;
        width: 260px; background: #1a1a2e; border-left: 1px solid #2d2d4e;
        display: flex; flex-direction: column; z-index: 20; transform: translateX(100%);
        transition: transform 0.2s; overflow-y: auto;
      }
      .sidebar.open { transform: none; }
      .sidebar-section { padding: 14px; border-bottom: 1px solid #2d2d4e; }
      .sidebar-section h4 { font-size: 11px; font-weight: 600; color: #6060a0; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 10px; }
      .token-list { display: flex; flex-direction: column; gap: 6px; }
      .token-item {
        display: flex; align-items: center; gap: 8px; padding: 7px 9px;
        border-radius: 7px; cursor: pointer; font-size: 13px; transition: background 0.15s;
      }
      .token-item:hover { background: #2d2d4e; }
      .token-item.selected { background: #1e3a5f; }
      .token-item.token-hidden { opacity: 0.55; }
      .token-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
      .token-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .icon-btn { background: none; border: none; cursor: pointer; color: #9090b0; font-size: 14px; padding: 2px; border-radius: 4px; }
      .icon-btn:hover { color: #e0e0f0; background: #2d2d4e; }

      /* Token editor */
      .token-editor { padding: 14px; }
      .field { margin-bottom: 10px; }
      .field label { display: block; font-size: 11px; color: #6060a0; margin-bottom: 4px; }
      .field input[type=text], .field input[type=number] {
        width: 100%; padding: 7px 10px; background: #0f0f1a; border: 1px solid #2d2d4e;
        border-radius: 6px; color: #e0e0f0; font-size: 13px; outline: none;
      }
      .field input:focus { border-color: #4a90d9; }
      .field-row { display: flex; gap: 8px; }
      .field-row .field { flex: 1; }
      .checkbox-row { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
      .checkbox-row input { cursor: pointer; }
      .color-input { width: 40px; height: 30px; border: 1px solid #2d2d4e; border-radius: 6px; cursor: pointer; background: none; padding: 2px; }
      .save-btn { width: 100%; padding: 8px; background: #4a90d9; border: none; border-radius: 7px; color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; margin-top: 4px; }
      .save-btn:hover { background: #357abd; }
      .del-btn { width: 100%; padding: 7px; background: transparent; border: 1px solid #dc2626; border-radius: 7px; color: #f87171; font-size: 13px; cursor: pointer; margin-top: 6px; }
      .del-btn:hover { background: #dc2626; color: #fff; }

      /* Chat */
      .chat-wrap { position: absolute; bottom: 12px; left: 12px; width: 280px; z-index: 20; }
      .chat-messages {
        background: rgba(10,10,20,0.85); border: 1px solid #2d2d4e; border-radius: 8px;
        padding: 8px; max-height: 160px; overflow-y: auto; margin-bottom: 6px;
        font-size: 12px; display: flex; flex-direction: column; gap: 3px;
      }
      .chat-msg { color: #c0c0e0; }
      .chat-msg strong { color: #4a90d9; }
      .chat-input-row { display: flex; gap: 6px; }
      .chat-input {
        flex: 1; padding: 6px 10px; background: rgba(15,15,30,0.9); border: 1px solid #2d2d4e;
        border-radius: 6px; color: #e0e0f0; font-size: 12px; outline: none;
      }
      .chat-send { padding: 6px 12px; background: #4a90d9; border: none; border-radius: 6px; color: #fff; cursor: pointer; font-size: 12px; }

      /* Notifications */
      .notif { position: absolute; top: 52px; left: 50%; transform: translateX(-50%);
        background: #1a1a2e; border: 1px solid #2d2d4e; border-radius: 8px;
        padding: 8px 16px; font-size: 13px; color: #e0e0f0; z-index: 30;
        opacity: 0; transition: opacity 0.3s; pointer-events: none; }
      .notif.show { opacity: 1; }

      .toolbar-group { display: flex; gap: 4px; align-items: center; }
      .tool-btn {
        width: 30px; height: 30px; border-radius: 6px; border: 1px solid #2d2d4e;
        background: transparent; color: #c0c0e0; cursor: pointer; font-size: 14px;
        display: flex; align-items: center; justify-content: center; transition: background 0.15s;
        position: relative;
      }
      .tool-btn:hover { background: #2d2d4e; }
      .tool-btn.active { background: #4a90d9; border-color: #4a90d9; color: #fff; }
      .tool-btn[title]:hover::after {
        content: attr(title); position: absolute; bottom: -28px; left: 50%; transform: translateX(-50%);
        background: #000; color: #fff; padding: 3px 7px; border-radius: 4px; font-size: 11px;
        white-space: nowrap; pointer-events: none; z-index: 100;
      }
    </style>

    <div class="game">
      <div class="game-header">
        <div class="game-header-left">
          <button class="header-btn" id="back-btn">← VTT</button>
          <div class="header-sep"></div>
          <span class="table-name">${esc(table.name)}</span>
          <div class="header-sep"></div>
          <div class="toolbar-group" id="tools">
            <button class="tool-btn active" data-tool="select" title="Select/Move (S)">↖</button>
            <button class="tool-btn" data-tool="line" title="Measure Line (L)">╱</button>
            <button class="tool-btn" data-tool="circle" title="Measure Circle (C)">◯</button>
            <button class="tool-btn" data-tool="square" title="Measure Square (Q)">▭</button>
            <button class="tool-btn" data-tool="cone" title="Measure Cone (N)">◤</button>
            ${isAdmin ? `
            <div class="header-sep"></div>
            <button class="tool-btn" data-tool="fog-reveal" title="Reveal Fog (R)">👁</button>
            <button class="tool-btn" data-tool="fog-erase" title="Erase Revealed (E)">🌑</button>
            ` : ''}
          </div>
          <div class="header-sep"></div>
          <button class="header-btn" id="snap-btn">Snap ✓</button>
          <button class="header-btn" id="grid-btn">Grid ✓</button>
          ${isAdmin ? `<button class="header-btn" id="fog-toggle-btn">Fog ✓</button>
          <button class="header-btn" id="share-measure-btn" title="Share measurements with players">Share ✗</button>` : ''}
        </div>
        <div class="game-header-right">
          ${isAdmin ? `<button class="header-btn" id="add-token-btn">+ Token</button>
          <button class="header-btn" id="clear-fog-btn">Clear Fog</button>` : ''}
          <button class="header-btn" id="music-btn" title="Music player">🎵</button>
          <button class="header-btn" id="sidebar-btn">Tokens ≡</button>
          ${isAdmin ? `<button class="header-btn" id="settings-btn">⚙ Settings</button>` : ''}
          <button class="header-btn" id="zen-btn" title="Fullscreen — hide menus (Esc to exit)">⛶</button>
          <span style="font-size:12px;color:#6060a0">${esc(user.username)}</span>
        </div>
      </div>

      <div class="canvas-wrap" id="canvas-wrap">
        <canvas id="canvas-main"></canvas>
        <canvas id="canvas-fog"></canvas>
        <canvas id="canvas-ui"></canvas>

        <div class="music-panel" id="music-panel">
          <div class="sidebar-section" style="display:flex;align-items:center;justify-content:space-between;">
            <span style="font-size:13px;font-weight:600;color:#c0c0e0;">Music</span>
            <button class="icon-btn" id="music-close">✕</button>
          </div>
          <div style="padding:12px 14px;display:flex;flex-direction:column;gap:10px;border-bottom:1px solid #2d2d4e;">
            <div id="music-now" style="font-size:13px;color:#e0e0f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Nothing playing</div>
            <div style="display:flex;align-items:center;gap:6px;">
              <button class="icon-btn" id="music-prev" title="Previous" style="font-size:16px;">⏮</button>
              <button class="icon-btn" id="music-play" title="Play / Pause" style="font-size:16px;">▶</button>
              <button class="icon-btn" id="music-next" title="Next" style="font-size:16px;">⏭</button>
              <span style="font-size:12px;color:#6060a0;">🔊</span>
              <input type="range" id="music-vol" min="0" max="1" step="0.05" style="flex:1;accent-color:#4a90d9;" title="Volume" />
            </div>
          </div>
          <div class="sidebar-section">
            <h4>Queue</h4>
            <div id="music-queue" style="display:flex;flex-direction:column;gap:4px;"></div>
          </div>
        </div>

        <div class="sidebar" id="sidebar">
          <div class="sidebar-section">
            <h4>Tokens</h4>
            <div class="token-list" id="token-list"></div>
            ${isAdmin ? `<button class="header-btn" style="width:100%;margin-top:8px;text-align:center" id="add-token-sidebar">+ Add Token</button>` : ''}
          </div>
          <div id="token-editor"></div>
        </div>

        ${isAdmin ? `
        <div class="sidebar" id="settings-panel" style="background:#131320;">
          <div class="sidebar-section" style="display:flex;align-items:center;justify-content:space-between;">
            <span style="font-size:13px;font-weight:600;color:#c0c0e0;">Settings</span>
            <button class="icon-btn" id="settings-close">✕</button>
          </div>
          <div id="settings-body" style="padding:14px;display:flex;flex-direction:column;gap:18px;"></div>
        </div>` : ''}
      </div>

      <div class="chat-wrap" id="chat-wrap">
        <div class="chat-messages" id="chat-messages"></div>
        <div class="chat-input-row">
          <input class="chat-input" id="chat-input" placeholder="Chat…" />
          <button class="chat-send" id="chat-send">→</button>
        </div>
      </div>

      <div class="notif" id="notif"></div>
    </div>
  `

  // Canvas setup
  const wrap = root.querySelector('#canvas-wrap') as HTMLElement
  const mainCanvas = root.querySelector('#canvas-main') as HTMLCanvasElement
  const fogCanvas = root.querySelector('#canvas-fog') as HTMLCanvasElement
  const uiCanvas = root.querySelector('#canvas-ui') as HTMLCanvasElement
  const mainCtx = mainCanvas.getContext('2d')!
  const fogCtx = fogCanvas.getContext('2d')!
  const uiCtx = uiCanvas.getContext('2d')!

  let rafId = 0
  function resizeCanvases() {
    const w = wrap.clientWidth, h = wrap.clientHeight
    for (const c of [mainCanvas, fogCanvas, uiCanvas]) {
      c.width = w; c.height = h
    }
    // Resizing a canvas clears it — repaint (zen mode, window resize)
    render()
  }

  // Game state
  const state: GameState = {
    table,
    tokens: [],
    fog: [],
    portals: [],
    walls: parseStaticWalls(table.uvt_metadata ?? '{}', table.grid_size),
    settings: { ...DEFAULT_SETTINGS },
    camera: { x: 0, y: 0, zoom: 1 },
    mapImage: null,
    mapImagePath: '',
    exploredCanvas: null,
    selectedId: null,
    tool: 'select',
    snap: true,
    gridVisible: true,
    fogEnabled: true,
    zen: false,
    measure: { active: false, tool: 'line', startX: 0, startY: 0, endX: 0, endY: 0 },
    sharedMeasure: null,
    shareMeasure: false,
    music: null,
    dragging: false, dragOffX: 0, dragOffY: 0, dragStartX: 0, dragStartY: 0,
    panning: false, panStartX: 0, panStartY: 0, panCamX: 0, panCamY: 0,
  }

  let lastMoveBroadcast = 0
  let lastMeasureBroadcast = 0

  function recomputeWalls() {
    state.walls = [
      ...parseStaticWalls(state.table.uvt_metadata ?? '{}', state.table.grid_size),
      ...portalWalls(state.portals),
    ]
  }

  // Load map image (also re-run when table_state brings a new map path)
  function loadMap() {
    const p = state.table.map_image_path
    if (!p || p === state.mapImagePath) return
    state.mapImagePath = p
    preloadMapImage(p, img => {
      if (state.table.map_image_path !== p) return // superseded by a newer map
      state.mapImage = img
      // Explored canvas lives in world space at the map's native resolution
      state.exploredCanvas = new OffscreenCanvas(img.width, img.height)
      render()
    })
  }
  loadMap()

  // Render loop
  function render() {
    cancelAnimationFrame(rafId)
    rafId = requestAnimationFrame(() => {
      const w = mainCanvas.width, h = mainCanvas.height

      // Per-token visibility: hidden tokens (and their sight) are invisible
      // to players; admins keep the full picture, hidden ones ghosted.
      const visibleTokens = isAdmin ? state.tokens : state.tokens.filter(t => !t.hidden)
      const hiddenTokens = isAdmin ? state.tokens.filter(t => t.hidden) : []

      // Main canvas: map + grid + tokens
      mainCtx.clearRect(0, 0, w, h)
      drawMap(mainCtx, state.mapImage, state.camera, state.table.map_offset_x, state.table.map_offset_y)
      if (state.gridVisible) {
        drawGrid(mainCtx, state.camera, state.table.grid_size, w, h)
      }
      drawPortals(mainCtx, state.portals, state.camera, isAdmin)
      drawTokens(mainCtx, visibleTokens, state.camera, state.table.grid_size, state.selectedId, user.username, isAdmin)
      if (hiddenTokens.length > 0) {
        mainCtx.globalAlpha = 0.5
        drawTokens(mainCtx, hiddenTokens, state.camera, state.table.grid_size, state.selectedId, user.username, isAdmin)
        mainCtx.globalAlpha = 1
      }

      // Fog canvas: punched only by the tokens each viewer can see (admins
      // see the sight of hidden tokens too)
      const sightTokens = isAdmin ? state.tokens : visibleTokens
      fogCtx.clearRect(0, 0, w, h)
      if (state.fogEnabled) {
        // Keep the explored memory up to date so areas that fall out of
        // sight keep showing in greyscale instead of going fully black
        if (state.exploredCanvas) {
          updateExplored(state.exploredCanvas, sightTokens, state.fog, state.walls, state.table.grid_size)
        }
        drawFog(
          fogCtx, sightTokens, state.fog, state.walls, state.camera, state.table.grid_size, isAdmin,
          state.exploredCanvas, state.mapImage,
          state.table.map_offset_x, state.table.map_offset_y,
        )
      }

      // UI canvas: shared (admin) measurement, then the local measuring tool
      uiCtx.clearRect(0, 0, w, h)
      const unitSize = state.settings.grid_square_size
      const unit = state.settings.measurement_unit
      if (state.sharedMeasure) {
        drawMeasure(uiCtx, state.sharedMeasure, state.camera, state.table.grid_size, unitSize, unit)
      }
      drawMeasure(uiCtx, state.measure, state.camera, state.table.grid_size, unitSize, unit)
    })
  }
  resizeCanvases()
  new ResizeObserver(resizeCanvases).observe(wrap)

  // Token list sidebar
  function refreshSidebar() {
    const list = root.querySelector('#token-list') as HTMLElement
    if (!list) return
    list.innerHTML = state.tokens.map(t => `
      <div class="token-item${t.id === state.selectedId ? ' selected' : ''}${t.hidden ? ' token-hidden' : ''}" data-token="${t.id}">
        <div class="token-dot" style="background:${t.color}"></div>
        <span class="token-name">${esc(t.name || 'Token')}</span>
        ${isAdmin ? `<button class="icon-btn" data-toggle-hide="${t.id}" title="${t.hidden ? 'Show to players' : 'Hide from players'}">${t.hidden ? '🚫' : '👁'}</button>
        <button class="icon-btn" data-focus="${t.id}" title="Focus">⊙</button>` : ''}
      </div>
    `).join('')

    list.querySelectorAll('[data-token]').forEach(el => {
      el.addEventListener('click', (e) => {
        const id = (el as HTMLElement).dataset.token!
        if ((e.target as HTMLElement).closest('[data-focus],[data-toggle-hide]')) return
        state.selectedId = id
        refreshSidebar()
        if (isAdmin) renderTokenEditor()
        render()
      })
    })
    list.querySelectorAll('[data-toggle-hide]').forEach(el => {
      el.addEventListener('click', async () => {
        const id = (el as HTMLElement).dataset.toggleHide!
        const token = state.tokens.find(t => t.id === id)
        if (!token) return
        const updated: Token = { ...token, hidden: !token.hidden }
        try {
          await api.updateToken(state.table.id, token.id, updated)
          const idx = state.tokens.findIndex(t => t.id === id)
          if (idx !== -1) state.tokens[idx] = updated
          socket.send('token_update', { token: updated })
          if (state.selectedId === id) renderTokenEditor()
        } catch { /* REST failed: server will re-sync via broadcast */ }
        refreshSidebar()
        render()
      })
    })
    list.querySelectorAll('[data-focus]').forEach(el => {
      el.addEventListener('click', () => {
        const id = (el as HTMLElement).dataset.focus!
        const token = state.tokens.find(t => t.id === id)
        if (token) {
          state.camera.x = token.x - mainCanvas.width / 2 / state.camera.zoom
          state.camera.y = token.y - mainCanvas.height / 2 / state.camera.zoom
          render()
        }
      })
    })
  }

  function renderTokenEditor() {
    const editorEl = root.querySelector('#token-editor') as HTMLElement
    if (!isAdmin) { editorEl.innerHTML = ''; return }
    const token = state.tokens.find(t => t.id === state.selectedId)
    if (!token) { editorEl.innerHTML = ''; return }

    editorEl.innerHTML = `
      <div class="token-editor">
        <div class="field"><label>Name</label><input type="text" id="te-name" value="${esc(token.name)}" /></div>
        <div class="field-row">
          <div class="field"><label>Size (sq)</label><input type="number" id="te-size" value="${token.size}" min="0.5" max="6" step="0.5" /></div>
          <div class="field"><label>Color</label><input type="color" class="color-input" id="te-color" value="${token.color}" /></div>
        </div>
        <div class="field"><label>Owner (username)</label><input type="text" id="te-owner" value="${esc(token.owner)}" /></div>
        <label class="checkbox-row">
          <input type="checkbox" id="te-vision" ${token.has_vision ? 'checked' : ''} />
          Has Vision
        </label>
        <label class="checkbox-row" style="margin-top:6px">
          <input type="checkbox" id="te-hidden" ${token.hidden ? 'checked' : ''} />
          Hidden from players
        </label>
        <div class="field" style="margin-top:8px"><label>Vision Radius (sq)</label><input type="number" id="te-vrad" value="${token.vision_radius}" min="1" max="60" /></div>
        <div class="field"><label>Icon URL / path</label><input type="text" id="te-icon" value="${esc(token.icon_path)}" /></div>
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;margin-bottom:10px">
          <input type="file" id="te-icon-file" accept="image/*" style="display:none" />
          <button class="header-btn" id="te-icon-upload-btn" style="font-size:12px">Upload icon</button>
        </label>
        <button class="save-btn" id="te-save">Save Token</button>
        <button class="del-btn" id="te-del">Delete Token</button>
      </div>
    `

    root.querySelector('#te-icon-upload-btn')?.addEventListener('click', () => {
      (root.querySelector('#te-icon-file') as HTMLInputElement).click()
    })
    root.querySelector('#te-icon-file')?.addEventListener('change', async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return
      try {
        const { path } = await api.uploadTokenIcon(file)
        ;(root.querySelector('#te-icon') as HTMLInputElement).value = path
        preloadTokenImage(path)
      } catch {}
    })

    root.querySelector('#te-save')?.addEventListener('click', async () => {
      const updated: Token = {
        ...token,
        name: (root.querySelector('#te-name') as HTMLInputElement).value.trim(),
        size: parseFloat((root.querySelector('#te-size') as HTMLInputElement).value) || 1,
        color: (root.querySelector('#te-color') as HTMLInputElement).value,
        owner: (root.querySelector('#te-owner') as HTMLInputElement).value.trim(),
        has_vision: (root.querySelector('#te-vision') as HTMLInputElement).checked,
        hidden: (root.querySelector('#te-hidden') as HTMLInputElement).checked,
        vision_radius: parseFloat((root.querySelector('#te-vrad') as HTMLInputElement).value) || 6,
        icon_path: (root.querySelector('#te-icon') as HTMLInputElement).value.trim(),
      }
      await api.updateToken(state.table.id, token.id, updated)
      const idx = state.tokens.findIndex(t => t.id === token.id)
      if (idx !== -1) state.tokens[idx] = updated
      if (updated.icon_path) preloadTokenImage(updated.icon_path)
      socket.send('token_update', { token: updated })
      refreshSidebar()
      render()
    })

    root.querySelector('#te-del')?.addEventListener('click', async () => {
      if (!confirm('Delete this token?')) return
      await api.deleteToken(state.table.id, token.id)
      socket.send('token_delete', { token_id: token.id })
      state.tokens = state.tokens.filter(t => t.id !== token.id)
      state.selectedId = null
      renderTokenEditor()
      refreshSidebar()
      render()
    })
  }

  // WebSocket
  const token = localStorage.getItem('token') ?? ''
  socket.connect(table.id, token)
  let initialStateLoaded = false

  const unsub = socket.on((msg) => {
    switch (msg.type) {
      case 'table_state': {
        const p = msg.payload as TableStatePayload
        state.table = p.table
        state.tokens = p.tokens ?? []
        state.fog = p.fog ?? []
        state.portals = p.portals ?? []
        if (p.settings) state.settings = { ...DEFAULT_SETTINGS, ...p.settings }
        if (!initialStateLoaded) {
          // Default-on-join settings apply once, when state first arrives.
          // Later table_state pushes (e.g. token visibility toggles) must
          // NOT reset the user's local view toggles.
          initialStateLoaded = true
          state.gridVisible = state.settings.grid_visible_default
          state.fogEnabled = state.settings.fog_enabled_default
          state.snap = state.settings.snap_default
        }
        recomputeWalls()
        loadMap()
        state.tokens.forEach(t => t.icon_path && preloadTokenImage(t.icon_path))
        applySettings()
        refreshSidebar()
        render()
        break
      }
      case 'portal_toggle': {
        const p = msg.payload as { portal: Portal }
        const idx = state.portals.findIndex(x => x.id === p.portal.id)
        if (idx !== -1) state.portals[idx] = p.portal
        recomputeWalls()
        render()
        break
      }
      case 'settings_update': {
        const p = msg.payload as { settings: AppSettings }
        state.settings = { ...DEFAULT_SETTINGS, ...p.settings }
        // An admin changed the global defaults: apply them live to the view
        state.gridVisible = state.settings.grid_visible_default
        state.fogEnabled = state.settings.fog_enabled_default
        state.snap = state.settings.snap_default
        applySettings()
        // Refresh the open settings panel so control states stay in sync live
        if (root.querySelector('#settings-panel')?.classList.contains('open')) {
          renderSettingsPanel()
        }
        break
      }
      case 'token_move': {
        const p = msg.payload as TokenMovePayload
        const t = state.tokens.find(t => t.id === p.token_id)
        if (t) { t.x = p.x; t.y = p.y; render() }
        break
      }
      case 'token_update': {
        const p = msg.payload as TokenUpdatePayload
        const idx = state.tokens.findIndex(t => t.id === p.token.id)
        if (idx !== -1) {
          state.tokens[idx] = p.token
        } else {
          state.tokens.push(p.token)  // token created while we were connected
        }
        if (p.token.icon_path) preloadTokenImage(p.token.icon_path)
        refreshSidebar()
        render()
        break
      }
      case 'token_delete': {
        const p = msg.payload as TokenDeletePayload
        state.tokens = state.tokens.filter(t => t.id !== p.token_id)
        if (state.selectedId === p.token_id) state.selectedId = null
        refreshSidebar()
        render()
        break
      }
      case 'fog_update': {
        const p = msg.payload as FogUpdatePayload
        if (p.action === 'clear_all') {
          state.fog = []
        } else if (p.action === 'add') {
          state.fog.push(...p.points)
        }
        render()
        break
      }
      case 'measure_update': {
        const p = msg.payload as MeasureUpdatePayload
        state.sharedMeasure = p.measure
        render()
        break
      }
      case 'music_state': {
        state.music = msg.payload as MusicStatePayload
        applyMusicState()
        break
      }
      case 'chat': {
        appendChat((msg.payload as { from: string; message: string }))
        break
      }
    }
  })

  // ── Music player ─────────────────────────────────────────────────────────────
  // Playback is driven by the server state; the volume is local to each browser.
  const audio = new Audio()
  audio.preload = 'auto'
  const savedVol = parseFloat(localStorage.getItem('musicVolume') ?? '')
  audio.volume = isFinite(savedVol) && savedVol >= 0 && savedVol <= 1 ? savedVol : 0.7

  let musicUnlockArmed = false
  function tryPlayMusic() {
    audio.play().catch(() => {
      // Browser autoplay policy: retry on the next user gesture
      if (musicUnlockArmed) return
      musicUnlockArmed = true
      showNotif('Click anywhere to enable music')
      const unlock = () => {
        musicUnlockArmed = false
        document.removeEventListener('click', unlock)
        if (state.music?.playing) audio.play().catch(() => {})
      }
      document.addEventListener('click', unlock)
    })
  }

  function applyMusicState() {
    const m = state.music
    renderMusicPanel()
    if (!m || !m.current) { audio.pause(); return }
    const track = m.tracks.find(t => t.id === m.current)
    if (!track) { audio.pause(); return }
    if (audio.dataset.trackId !== m.current) {
      audio.src = track.path
      audio.dataset.trackId = m.current
      audio.load()
    }
    const pos = m.playing ? m.position + (Date.now() - m.updatedAt) / 1000 : m.position
    if (Math.abs(audio.currentTime - pos) > 1.5) {
      try { audio.currentTime = pos } catch { /* metadata not loaded yet */ }
    }
    if (m.playing) tryPlayMusic()
    else audio.pause()
  }

  audio.addEventListener('loadedmetadata', () => {
    // Re-sync once the new track's metadata is available
    const m = state.music
    if (!m?.playing) return
    const pos = m.position + (Date.now() - m.updatedAt) / 1000
    if (Math.abs(audio.currentTime - pos) > 1.5) {
      try { audio.currentTime = pos } catch {}
    }
    tryPlayMusic()
  })
  audio.addEventListener('ended', () => {
    // Server auto-advances; the guard there ignores duplicate ended events
    if (state.music?.current) {
      socket.send('music_control', { action: 'ended', trackId: state.music.current })
    }
  })

  function renderMusicPanel() {
    const nowEl = root.querySelector('#music-now')
    const playBtn = root.querySelector('#music-play')
    const queueEl = root.querySelector('#music-queue') as HTMLElement | null
    if (!nowEl || !playBtn || !queueEl) return
    const m = state.music
    const cur = m?.current ? m.tracks.find(t => t.id === m.current) : null
    nowEl.textContent = cur ? `♪ ${cur.name}` : 'Nothing playing'
    playBtn.textContent = m?.playing ? '⏸' : '▶'

    queueEl.innerHTML = (m?.queue ?? []).map(id => {
      const t = m!.tracks.find(x => x.id === id)
      if (!t) return ''
      return `
        <div class="music-row${id === m!.current ? ' current' : ''}" data-mtrack="${t.id}" ${isAdmin ? '' : 'style="cursor:default"'}>
          <span class="music-name">${esc(t.name)}</span>
          <button class="icon-btn" data-mup="${t.id}" title="Move up">↑</button>
          <button class="icon-btn" data-mdown="${t.id}" title="Move down">↓</button>
        </div>`
    }).join('') || '<div style="font-size:12px;color:#6060a0;">No music uploaded yet</div>'

    queueEl.querySelectorAll('[data-mtrack]').forEach(el => {
      el.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('[data-mup],[data-mdown]')) return
        if (!isAdmin) return // selecting a track is admin-only
        socket.send('music_control', { action: 'select', trackId: (el as HTMLElement).dataset.mtrack })
      })
    })
    queueEl.querySelectorAll('[data-mup]').forEach(el => {
      el.addEventListener('click', () =>
        socket.send('music_control', { action: 'move', trackId: (el as HTMLElement).dataset.mup, dir: -1 }))
    })
    queueEl.querySelectorAll('[data-mdown]').forEach(el => {
      el.addEventListener('click', () =>
        socket.send('music_control', { action: 'move', trackId: (el as HTMLElement).dataset.mdown, dir: 1 }))
    })
  }

  root.querySelector('#music-btn')?.addEventListener('click', () => {
    root.querySelector('#sidebar')?.classList.remove('open')
    root.querySelector('#settings-panel')?.classList.remove('open')
    root.querySelector('#music-panel')?.classList.toggle('open')
  })
  root.querySelector('#music-close')?.addEventListener('click', () => {
    root.querySelector('#music-panel')?.classList.remove('open')
  })
  root.querySelector('#music-prev')?.addEventListener('click', () => socket.send('music_control', { action: 'prev' }))
  root.querySelector('#music-next')?.addEventListener('click', () => socket.send('music_control', { action: 'next' }))
  root.querySelector('#music-play')?.addEventListener('click', () =>
    socket.send('music_control', { action: state.music?.playing ? 'pause' : 'play' }))
  const musicVol = root.querySelector('#music-vol') as HTMLInputElement | null
  if (musicVol) {
    musicVol.value = String(audio.volume)
    musicVol.addEventListener('input', () => {
      audio.volume = parseFloat(musicVol.value)
      localStorage.setItem('musicVolume', musicVol.value)
    })
  }

  // Header buttons
  root.querySelector('#back-btn')!.addEventListener('click', () => {
    onBack() // route() unmounts the page, which runs teardown
  })

  root.querySelector('#sidebar-btn')!.addEventListener('click', () => {
    root.querySelector('#settings-panel')?.classList.remove('open')
    root.querySelector('#sidebar')!.classList.toggle('open')
  })

  // Fullscreen (zen) mode — hide every menu AND take the browser fullscreen.
  // Esc exits the browser fullscreen natively; fullscreenchange brings the
  // menus back.
  const gameRoot = root.querySelector('.game') as HTMLElement

  function closeAllPanels() {
    root.querySelector('#sidebar')?.classList.remove('open')
    root.querySelector('#settings-panel')?.classList.remove('open')
    root.querySelector('#music-panel')?.classList.remove('open')
  }

  async function enterZen() {
    state.zen = true
    gameRoot.classList.add('zen')
    closeAllPanels()
    // canvas-wrap resizes; the ResizeObserver repaints
    try { await root.requestFullscreen() } catch { /* browser refused: stay applicative-fullscreen */ }
  }

  function exitZen() {
    state.zen = false
    gameRoot.classList.remove('zen')
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    }
  }

  root.querySelector('#zen-btn')?.addEventListener('click', () => {
    if (state.zen) exitZen()
    else void enterZen()
  })

  const onFullscreenChange = () => {
    if (!document.fullscreenElement && state.zen) {
      // Browser left fullscreen (Esc / F11) — restore the menus too
      state.zen = false
      gameRoot.classList.remove('zen')
    }
  }
  document.addEventListener('fullscreenchange', onFullscreenChange)

  // Settings panel (admin only)
  const settingsPanel = root.querySelector('#settings-panel') as HTMLElement | null
  const settingsBody = root.querySelector('#settings-body') as HTMLElement | null

  function renderSettingsPanel() {
    if (!isAdmin || !settingsBody) return
    const s = state.settings
    settingsBody.innerHTML = [
      settingToggle('chat_enabled',          s.chat_enabled,          'Chat',               'Players can send and receive chat messages'),
      settingToggle('players_move_own_only', s.players_move_own_only, 'Players move own tokens only', 'When enabled, players can only drag tokens they own'),
      settingToggle('fog_enabled_default',   s.fog_enabled_default,   'Fog of War (default on)', 'Whether fog is active when joining a table'),
      settingToggle('grid_visible_default',  s.grid_visible_default,  'Grid (default visible)',     'Whether the grid is shown when joining a table'),
      settingToggle('snap_default',          s.snap_default,          'Snap to grid (default on)', 'Whether tokens snap to the grid when joining a table'),
      `
      <label style="display:flex;flex-direction:column;gap:4px;cursor:pointer;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <span style="font-size:13px;color:#e0e0f0;font-weight:500;">Grid square size</span>
          <div style="display:flex;align-items:center;gap:6px;">
            <input type="number" id="set-square-size" value="${s.grid_square_size}" min="0.5" step="0.5"
              style="width:64px;padding:5px 8px;background:#0f0f1a;border:1px solid #2d2d4e;border-radius:6px;color:#e0e0f0;font-size:13px;outline:none;" />
            <select id="set-unit"
              style="padding:5px 8px;background:#0f0f1a;border:1px solid #2d2d4e;border-radius:6px;color:#e0e0f0;font-size:13px;outline:none;">
              <option value="ft" ${s.measurement_unit === 'ft' ? 'selected' : ''}>ft</option>
              <option value="m" ${s.measurement_unit === 'm' ? 'selected' : ''}>m</option>
            </select>
          </div>
        </div>
        <span style="font-size:11px;color:#5050a0;">Real-world size of one grid square, used by the measurement tools</span>
      </label>`,
    ].join('')

    settingsBody.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', async () => {
        const key = cb.dataset.key as keyof typeof state.settings
        const value = cb.checked
        try {
          const updated = await api.patchSettings({ [key]: value })
          state.settings = { ...state.settings, ...updated }
          applySettings()
        } catch {
          cb.checked = !cb.checked // revert on error
        }
      })
    })

    settingsBody.querySelector('#set-square-size')?.addEventListener('change', async (e) => {
      const input = e.target as HTMLInputElement
      const value = parseFloat(input.value)
      if (!isFinite(value) || value <= 0) { input.value = String(state.settings.grid_square_size); return }
      try {
        const updated = await api.patchSettings({ grid_square_size: value })
        state.settings = { ...state.settings, ...updated }
        render()
      } catch {
        input.value = String(state.settings.grid_square_size)
      }
    })

    settingsBody.querySelector('#set-unit')?.addEventListener('change', async (e) => {
      const select = e.target as HTMLSelectElement
      const value = select.value === 'm' ? 'm' as const : 'ft' as const
      try {
        const updated = await api.patchSettings({ measurement_unit: value })
        state.settings = { ...state.settings, ...updated }
        render()
      } catch {
        select.value = state.settings.measurement_unit
      }
    })
  }

  if (isAdmin && settingsPanel) {
    root.querySelector('#settings-btn')!.addEventListener('click', () => {
      root.querySelector('#sidebar')?.classList.remove('open')
      settingsPanel.classList.toggle('open')
      renderSettingsPanel()
    })
    root.querySelector('#settings-close')!.addEventListener('click', () => {
      settingsPanel.classList.remove('open')
    })
  }

  function applySettings() {
    // Chat visibility only. Grid/Fog/Snap are user view toggles: they take
    // their default on join and when an admin changes the global defaults
    // (settings_update), but never from routine table_state pushes.
    const chatWrap = root.querySelector('#chat-wrap') as HTMLElement | null
    if (chatWrap) chatWrap.style.display = state.settings.chat_enabled ? '' : 'none'
    updateHeaderToggles()
    render()
  }

  // Tools
  root.querySelectorAll('[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tool = (btn as HTMLElement).dataset.tool as ToolType
      state.tool = tool
      root.querySelectorAll('[data-tool]').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
    })
  })

  // Snap toggle
  const snapBtn = root.querySelector('#snap-btn') as HTMLButtonElement
  snapBtn?.addEventListener('click', () => {
    state.snap = !state.snap
    updateHeaderToggles()
  })

  // Grid toggle
  const gridBtn = root.querySelector('#grid-btn') as HTMLButtonElement
  gridBtn?.addEventListener('click', () => {
    state.gridVisible = !state.gridVisible
    updateHeaderToggles()
    render()
  })

  // Fog toggle (admin)
  const fogToggle = root.querySelector('#fog-toggle-btn') as HTMLButtonElement
  fogToggle?.addEventListener('click', () => {
    state.fogEnabled = !state.fogEnabled
    updateHeaderToggles()
    render()
  })

  // Share measurements with players (admin)
  const shareBtn = root.querySelector('#share-measure-btn') as HTMLButtonElement
  shareBtn?.addEventListener('click', () => {
    state.shareMeasure = !state.shareMeasure
    if (!state.shareMeasure) {
      state.sharedMeasure = null
      socket.send('measure_update', { measure: null })
    }
    updateHeaderToggles()
    render()
  })

  function updateHeaderToggles() {
    if (snapBtn) {
      snapBtn.textContent = `Snap ${state.snap ? '✓' : '✗'}`
      snapBtn.classList.toggle('active', state.snap)
    }
    if (gridBtn) {
      gridBtn.textContent = `Grid ${state.gridVisible ? '✓' : '✗'}`
      gridBtn.classList.toggle('active', state.gridVisible)
    }
    if (fogToggle) {
      fogToggle.textContent = `Fog ${state.fogEnabled ? '✓' : '✗'}`
      fogToggle.classList.toggle('active', state.fogEnabled)
    }
    if (shareBtn) {
      shareBtn.textContent = `Share ${state.shareMeasure ? '✓' : '✗'}`
      shareBtn.classList.toggle('active', state.shareMeasure)
    }
  }
  updateHeaderToggles()

  // Clear fog (admin)
  root.querySelector('#clear-fog-btn')?.addEventListener('click', async () => {
    if (!confirm('Clear all manually revealed fog?')) return
    await api.clearFog(table.id)
    socket.send('fog_update', { action: 'clear_all', points: [] })
    state.fog = []
    render()
  })

  // Add token (admin)
  const addTokenFn = async () => {
    if (!isAdmin) return
    const name = prompt('Token name:', 'Fighter')
    if (!name) return
    try {
      const newToken = await api.createToken(table.id, {
        name,
        x: state.camera.x + mainCanvas.width / 2 / state.camera.zoom,
        y: state.camera.y + mainCanvas.height / 2 / state.camera.zoom,
        size: 1, color: randomColor(), has_vision: false, vision_radius: 6,
      })
      state.tokens.push(newToken)
      state.selectedId = newToken.id
      socket.send('token_update', { token: newToken })
      refreshSidebar()
      renderTokenEditor()
      if (!root.querySelector('#sidebar')!.classList.contains('open'))
        root.querySelector('#sidebar')!.classList.add('open')
      render()
    } catch (e: any) { showNotif('Error: ' + e.message) }
  }
  root.querySelector('#add-token-btn')?.addEventListener('click', addTokenFn)
  root.querySelector('#add-token-sidebar')?.addEventListener('click', addTokenFn)

  // Canvas mouse events
  uiCanvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    state.camera = zoomAround(state.camera, e.offsetX, e.offsetY, -e.deltaY)
    render()
  }, { passive: false })

  uiCanvas.addEventListener('mousedown', (e) => {
    const [wx, wy] = screenToWorld(e.offsetX, e.offsetY, state.camera)

    if (e.button === 1 || (e.button === 2)) {
      // Middle/right mouse = pan
      state.panning = true
      state.panStartX = e.offsetX; state.panStartY = e.offsetY
      state.panCamX = state.camera.x; state.panCamY = state.camera.y
      uiCanvas.style.cursor = 'grabbing'
      return
    }

    if (e.button === 0) {
      if (state.tool === 'fog-reveal' && isAdmin) {
        addFogPoint(wx, wy)
        return
      }
      if (state.tool === 'fog-erase' && isAdmin) {
        removeFogPoint(wx, wy)
        return
      }
      if (state.tool !== 'select') {
        // Start measuring
        state.measure = { active: true, tool: state.tool, startX: wx, startY: wy, endX: wx, endY: wy }
        if (isAdmin && state.shareMeasure) {
          socket.send('measure_update', { measure: { ...state.measure } })
        }
        return
      }

      // Admin: check portal click first (threshold = 30% of a grid cell)
      if (isAdmin) {
        const portalHit = pickPortal(wx, wy, state.portals, state.table.grid_size * 0.3)
        if (portalHit) {
          api.togglePortal(state.table.id, portalHit.id, !portalHit.closed)
            .then(updated => {
              const idx = state.portals.findIndex(p => p.id === updated.id)
              if (idx !== -1) state.portals[idx] = updated
              recomputeWalls()
              render()
            })
            .catch(() => showNotif('Failed to toggle portal'))
          return
        }
      }

      // select tool: pick token
      const hit = pickToken(wx, wy, state.tokens, state.table.grid_size)
      if (hit) {
        const canMove = isAdmin || !state.settings.players_move_own_only || hit.owner === user.username
        if (canMove) {
          state.selectedId = hit.id
          const [tx, ty] = worldToScreen(hit.x, hit.y, state.camera)
          state.dragging = true
          state.dragOffX = e.offsetX - tx
          state.dragOffY = e.offsetY - ty
          state.dragStartX = hit.x
          state.dragStartY = hit.y
        } else {
          state.selectedId = hit.id
        }
        refreshSidebar()
        if (isAdmin) renderTokenEditor()
      } else {
        state.selectedId = null
        refreshSidebar()
        if (isAdmin) renderTokenEditor()
      }
      render()
    }
  })

  uiCanvas.addEventListener('mousemove', (e) => {
    if (state.panning) {
      const dx = (e.offsetX - state.panStartX) / state.camera.zoom
      const dy = (e.offsetY - state.panStartY) / state.camera.zoom
      state.camera = { ...state.camera, x: state.panCamX - dx, y: state.panCamY - dy }
      render()
      return
    }

    if (state.dragging && state.selectedId) {
      const [wx, wy] = screenToWorld(e.offsetX - state.dragOffX, e.offsetY - state.dragOffY, state.camera)
      const snapX = state.snap ? snapToGrid(wx, state.table.grid_size) : wx
      const snapY = state.snap ? snapToGrid(wy, state.table.grid_size) : wy
      const token = state.tokens.find(t => t.id === state.selectedId)
      if (token) {
        // Block at walls during the drag: only accept positions whose path
        // from the current position crosses no wall/closed door (and doesn't
        // land on one), so the token slides along walls but never walks
        // through them.
        if (!pathCrossesWall(token.x, token.y, snapX, snapY, state.walls)
            && !pointOnWall(snapX, snapY, state.walls)) {
          token.x = snapX
          token.y = snapY
        }
        // Throttle: broadcast live position at ~20 fps so other clients see the drag in real-time
        const now = Date.now()
        if (now - lastMoveBroadcast > 50) {
          socket.send('token_move', { token_id: token.id, x: token.x, y: token.y })
          lastMoveBroadcast = now
        }
      }
      render()
      return
    }

    if (state.measure.active) {
      const [wx, wy] = screenToWorld(e.offsetX, e.offsetY, state.camera)
      state.measure.endX = wx; state.measure.endY = wy
      const now = Date.now()
      if (isAdmin && state.shareMeasure && now - lastMeasureBroadcast > 50) {
        socket.send('measure_update', { measure: { ...state.measure } })
        lastMeasureBroadcast = now
      }
      render()
      return
    }

    // Cursor hint for portal hover (admin only)
    if (isAdmin && state.tool === 'select' && !state.dragging && !state.panning) {
      const [wx, wy] = screenToWorld(e.offsetX, e.offsetY, state.camera)
      const near = pickPortal(wx, wy, state.portals, state.table.grid_size * 0.3)
      uiCanvas.style.cursor = near ? 'pointer' : 'crosshair'
    }
  })

  uiCanvas.addEventListener('mouseup', async (e) => {
    if (state.panning) {
      state.panning = false
      uiCanvas.style.cursor = 'crosshair'
      return
    }

    if (state.dragging && state.selectedId) {
      state.dragging = false
      const token = state.tokens.find(t => t.id === state.selectedId)
      if (token) {
        // The drag already blocks walls incrementally; this is only a safety
        // net for races (e.g. a door closed mid-drag by another client).
        const blocked = pathCrossesWall(
          state.dragStartX, state.dragStartY,
          token.x, token.y,
          state.walls,
        ) || pointOnWall(token.x, token.y, state.walls)
        if (blocked) {
          // Revert locally and tell every other client to snap back too
          token.x = state.dragStartX
          token.y = state.dragStartY
          socket.send('token_move', { token_id: token.id, x: state.dragStartX, y: state.dragStartY })
          showNotif('Movement blocked by wall')
          render()
        } else {
          socket.send('token_move', { token_id: token.id, x: token.x, y: token.y })
        }
      }
      return
    }

    if (state.measure.active && e.button === 0) {
      state.measure.active = false
      // Keep a shared measurement visible after release — on the players'
      // screens (broadcast) and on the admin's own screen for consistency
      if (isAdmin && state.shareMeasure) {
        const persisted: MeasureState = { ...state.measure, active: false, persist: true }
        socket.send('measure_update', { measure: persisted })
        state.sharedMeasure = persisted
      }
      render()
    }
  })

  uiCanvas.addEventListener('contextmenu', e => e.preventDefault())

  // Touch support (basic pinch-zoom + pan)
  let touches: Touch[] = []
  let lastTouchDist = 0
  uiCanvas.addEventListener('touchstart', (e) => {
    e.preventDefault()
    touches = Array.from(e.touches)
    if (touches.length === 2) {
      lastTouchDist = Math.hypot(
        touches[0].clientX - touches[1].clientX,
        touches[0].clientY - touches[1].clientY,
      )
    } else if (touches.length === 1) {
      const rect = uiCanvas.getBoundingClientRect()
      state.panning = true
      state.panStartX = touches[0].clientX - rect.left
      state.panStartY = touches[0].clientY - rect.top
      state.panCamX = state.camera.x; state.panCamY = state.camera.y
    }
  }, { passive: false })

  uiCanvas.addEventListener('touchmove', (e) => {
    e.preventDefault()
    const rect = uiCanvas.getBoundingClientRect()
    if (e.touches.length === 2) {
      const t = Array.from(e.touches)
      const d = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
      const cx = (t[0].clientX + t[1].clientX) / 2 - rect.left
      const cy = (t[0].clientY + t[1].clientY) / 2 - rect.top
      if (lastTouchDist > 0) {
        const delta = d > lastTouchDist ? 1 : -1
        state.camera = zoomAround(state.camera, cx, cy, delta)
      }
      lastTouchDist = d
      render()
    } else if (e.touches.length === 1 && state.panning) {
      const ox = e.touches[0].clientX - rect.left
      const oy = e.touches[0].clientY - rect.top
      const dx = (ox - state.panStartX) / state.camera.zoom
      const dy = (oy - state.panStartY) / state.camera.zoom
      state.camera = { ...state.camera, x: state.panCamX - dx, y: state.panCamY - dy }
      render()
    }
  }, { passive: false })

  uiCanvas.addEventListener('touchend', () => {
    state.panning = false; touches = []; lastTouchDist = 0
  })

  // Keyboard shortcuts
  const onKeydown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    const map: Record<string, ToolType> = { s: 'select', l: 'line', c: 'circle', q: 'square', n: 'cone' }
    if (map[e.key.toLowerCase()]) {
      state.tool = map[e.key.toLowerCase()]
      root.querySelectorAll('[data-tool]').forEach(b => {
        b.classList.toggle('active', (b as HTMLElement).dataset.tool === state.tool)
      })
    }
    if (e.key === 'Escape') {
      if (state.zen) exitZen()
      state.selectedId = null
      state.measure.active = false
      if (state.shareMeasure) socket.send('measure_update', { measure: null })
      refreshSidebar(); renderTokenEditor(); render()
    }
    if (e.key === 'Delete' && state.selectedId && isAdmin) {
      const token = state.tokens.find(t => t.id === state.selectedId)
      if (token && confirm(`Delete ${token.name}?`)) {
        api.deleteToken(state.table.id, token.id)
        socket.send('token_delete', { token_id: token.id })
        state.tokens = state.tokens.filter(t => t.id !== token.id)
        state.selectedId = null
        refreshSidebar(); renderTokenEditor(); render()
      }
    }
  }
  document.addEventListener('keydown', onKeydown)

  // Release sockets/listeners when the page is unmounted (navigation,
  // browser back/forward, logout)
  onTeardown(() => {
    unsub()
    socket.disconnect()
    document.removeEventListener('keydown', onKeydown)
    document.removeEventListener('fullscreenchange', onFullscreenChange)
    cancelAnimationFrame(rafId)
    audio.pause()
    audio.removeAttribute('src')
  })

  // Chat
  const chatInput = root.querySelector('#chat-input') as HTMLInputElement
  const sendChat = () => {
    const msg = chatInput.value.trim()
    if (!msg) return
    chatInput.value = ''
    const payload = { from: user.username, message: msg }
    socket.send('chat', payload)
    appendChat(payload)
  }
  root.querySelector('#chat-send')!.addEventListener('click', sendChat)
  chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat() })

  function appendChat(payload: { from: string; message: string }) {
    const msgs = root.querySelector('#chat-messages') as HTMLElement
    const div = document.createElement('div')
    div.className = 'chat-msg'
    div.innerHTML = `<strong>${esc(payload.from)}</strong>: ${esc(payload.message)}`
    msgs.appendChild(div)
    msgs.scrollTop = msgs.scrollHeight
  }

  // Fog helpers
  function addFogPoint(wx: number, wy: number) {
    const point: FogPoint = { id: '', table_id: table.id, x: wx, y: wy, radius: 3 }
    socket.send('fog_update', { action: 'add', points: [point] })
    state.fog.push(point)
    render()
  }

  function removeFogPoint(wx: number, wy: number) {
    state.fog = state.fog.filter(p => Math.hypot(p.x - wx, p.y - wy) > p.radius * state.table.grid_size)
    // Clear server state then re-add the remaining points
    socket.send('fog_update', { action: 'clear_all', points: [] })
    if (state.fog.length > 0) {
      socket.send('fog_update', { action: 'add', points: state.fog })
    }
    render()
  }

  function showNotif(msg: string) {
    const el = root.querySelector('#notif') as HTMLElement
    el.textContent = msg
    el.classList.add('show')
    setTimeout(() => el.classList.remove('show'), 2500)
  }

  render()
}

function pickPortal(wx: number, wy: number, portals: Portal[], threshold: number): Portal | null {
  for (const p of portals) {
    const dx = p.x2 - p.x1, dy = p.y2 - p.y1
    const lenSq = dx * dx + dy * dy
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((wx - p.x1) * dx + (wy - p.y1) * dy) / lenSq))
    const dist = Math.hypot(wx - (p.x1 + t * dx), wy - (p.y1 + t * dy))
    if (dist < threshold) return p
  }
  return null
}

function pickToken(wx: number, wy: number, tokens: Token[], gridSize: number): Token | null {
  // iterate in reverse (top token first)
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]
    const r = (gridSize * t.size) / 2
    if (Math.hypot(wx - t.x, wy - t.y) <= r) return t
  }
  return null
}

function randomColor() {
  const colors = ['#4a90d9', '#e06c75', '#98c379', '#d19a66', '#c678dd', '#56b6c2', '#e5c07b']
  return colors[Math.floor(Math.random() * colors.length)]
}

function esc(s: string) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function settingToggle(key: string, value: boolean, label: string, description: string): string {
  return `
    <label style="display:flex;flex-direction:column;gap:4px;cursor:pointer;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
        <span style="font-size:13px;color:#e0e0f0;font-weight:500;">${esc(label)}</span>
        <div style="position:relative;width:36px;height:20px;flex-shrink:0;">
          <input type="checkbox" data-key="${esc(key)}" ${value ? 'checked' : ''}
            style="opacity:0;width:0;height:0;position:absolute;" />
          <span class="toggle-track" style="
            position:absolute;inset:0;border-radius:20px;transition:background 0.2s;
            background:${value ? '#4a90d9' : '#2d2d4e'};cursor:pointer;">
            <span style="
              position:absolute;top:2px;left:${value ? '18px' : '2px'};
              width:16px;height:16px;border-radius:50%;background:#fff;
              transition:left 0.2s;pointer-events:none;"></span>
          </span>
        </div>
      </div>
      <span style="font-size:11px;color:#5050a0;">${esc(description)}</span>
    </label>
  `
}
