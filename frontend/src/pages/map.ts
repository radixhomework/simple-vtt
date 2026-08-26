/**
 * Map page — the VTT itself. Owns the game state (table, tokens, fog,
 * portals, camera, settings, music), three stacked canvases (map/tokens,
 * fog, UI overlays) and all input: mouse, touch/Apple Pencil, keyboard.
 * Mutations flow through the WebSocket singleton; server pushes
 * (table_state, token_*, fog_update, measure_update, music_state,
 * settings_update, chat) keep every browser in sync.
 */
import { api } from '../api/client'
import { socket } from '../api/websocket'
import {
  drawMap, drawGrid, drawTokens, drawFog, drawPortals, drawMeasure, drawStairs,
  preloadTokenImage, preloadMapImage, updateExplored, clearMapImageCache,
  resetVisionCache, DRAG_QUANTUM,
  initLosWorker, updateLosWorkerWalls, setLosResultHandler, disposeLosWorker, applyLosResult,
} from '../canvas/layers'
import { drawTiledMap, resetTileCache } from '../canvas/tiles'
import { screenToWorld, worldToScreen, snapToGrid, zoomAround } from '../canvas/camera'
import { portalWalls, portalSightWalls, pathCrossesWall, pointOnWall } from '../canvas/los'
import { loadMode, saveMode, drawWallsOverlay, drawMarquee, drawWallGhost, pickWall, wallsInRect, pickPortalBuild, drawPortalsBuild, type PageMode } from '../canvas/build'
import type { WallSegment } from '../canvas/los'
import type {
  User, Table, Token, FogPoint, Portal, Camera, ToolType, MeasureState, TableSettings,
  TableStatePayload, TokenMovePayload, TokenUpdatePayload, TokenDeletePayload, FogUpdatePayload,
  MeasureUpdatePayload, MusicStatePayload, Asset, Floor, FloorLite, Stairs, MapMember, WallRecord,
} from '../types'
import { DEFAULT_TABLE_SETTINGS } from '../types'

interface GameState {
  /** Table merged with the active floor's map fields — everything downstream
   *  (grid_size, offsets, walls) reads from here and stays floor-agnostic. */
  table: Table
  floors: FloorLite[]
  floor: Floor | null
  stairs: Stairs[]
  tokens: Token[]
  fog: FogPoint[]
  portals: Portal[]
  walls: WallSegment[]
  /** Build-mode wall rows (persisted; the source of `walls` above). */
  wallRecords: WallRecord[]
  /** Sight blockers: static walls + closed doors only (windows are transparent) */
  sightWalls: WallSegment[]
  settings: TableSettings
  camera: Camera
  mapImage: HTMLImageElement | null
  mapImagePath: string
  /** z0 overview tile used as the fog's greyscale source on tiled floors. */
  fogOverview: ImageBitmap | null
  /** tiles_path of the pyramid currently loaded — guards loadMap() against
   *  re-wiping the tile cache on routine table_state pushes. */
  activeTilesPath: string
  exploredCanvas: OffscreenCanvas | null
  selectedId: string | null
  tool: ToolType
  /** play (classic behavior) or build (authoring) — admin-only. */
  mode: PageMode
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

/** Floor map fields overlaid onto state.table so existing readers keep working. */
function floorFields(f: Floor | null | undefined): Partial<Table> {
  if (!f) return {}
  return {
    map_image_path: f.map_image_path,
    grid_size: f.grid_size,
    uvt_metadata: f.uvt_metadata,
    map_offset_x: f.map_offset_x,
    map_offset_y: f.map_offset_y,
  }
}

export function floorLabel(f: { level: number; name: string }): string {
  return f.name ? `#${f.level} ${f.name}` : `Floor ${f.level}`
}

export function renderMap(
  root: HTMLElement,
  user: User,
  table: Table,
  onTeardown: (teardown: () => void) => void,
  onBack: () => void,
) {
  // DM flag follows the MAP role (from table_state), not the global role:
  // an admin invited as player is a player here; a user who uploaded the map
  // is its dm. Global role is only a guess for the very first paint.
  let isAdmin = user.role === 'admin'
  const setMapRole = (role: 'dm' | 'player') => {
    const was = isAdmin
    isAdmin = role === 'dm'
    if (was !== isAdmin) {
      // Hidden tokens contribute sight only for admins: the explored memory
      // must be restamped for the new perspective
      markExploredDirty()
      refreshSidebar()
      renderTokenEditor()
      updateHeaderToggles()
      render()
    }
  }

  root.innerHTML = `
    <style>
      .game { display: flex; flex-direction: column; height: 100%; background: #1E211C; overflow: hidden; }
      /* Fullscreen mode: hide every menu, keep only the canvases */
      .game.zen .game-header, .game.zen .chat-wrap, .game.zen .sidebar, .game.zen .music-panel { display: none; }

      /* Music panel (left side). direction:rtl moves its scrollbar to the
         panel's left edge — i.e. the window edge, not the middle of the
         screen. Children re-set ltr to render normally. */
      .music-panel {
        position: absolute; left: 0; top: 0; bottom: 0;
        width: 260px; max-width: calc(100vw - 24px); background: var(--surface); border-right: 1px solid var(--border);
        display: flex; flex-direction: column; z-index: 20; transform: translateX(-100%);
        transition: transform 0.2s; overflow-y: auto; direction: rtl;
      }
      .music-panel.open { transform: none; }
      .music-panel > * { direction: ltr; }
      .music-row {
        display: flex; align-items: center; gap: 6px; padding: 6px 8px;
        border-radius: 6px; cursor: pointer; font-size: 13px; transition: background 0.15s;
      }
      .music-row:hover { background: rgba(30,33,28,0.08); }
      .music-row.current { background: rgba(154,118,86,0.30); }
      .music-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .game-header {
        display: flex; align-items: center; gap: 10px; row-gap: 6px;
        padding: 6px 12px; min-height: 44px; background: var(--header);
        border-bottom: 1px solid var(--border); flex-shrink: 0; z-index: 10;
        user-select: none; flex-wrap: wrap;
      }
      .game-header-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .game-header-right { display: flex; align-items: center; gap: 8px; margin-left: auto; flex-wrap: wrap; }
      .header-btn {
        padding: 8px 11px; border-radius: 6px; border: 1px solid var(--border);
        background: transparent; color: var(--text); font-size: 12px; cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
      }
      .header-btn:hover { background: rgba(30,33,28,0.08); }
      .header-btn.active { background: var(--brand); border-color: var(--brand); color: var(--on-brand); }
      .header-sep { width: 1px; height: 22px; background: var(--border); }
      .table-name { font-family: var(--font-title); font-size: 16px; font-weight: 600; color: var(--text); max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .canvas-wrap { flex: 1; position: relative; overflow: hidden; }
      canvas { position: absolute; top: 0; left: 0; cursor: crosshair; touch-action: none; }
      #canvas-main { z-index: 1; }
      #canvas-fog  { z-index: 2; pointer-events: none; }
      #canvas-ui   { z-index: 3; }

      /* Sidebar */
      .sidebar {
        position: absolute; right: 0; top: 0; bottom: 0;
        width: 260px; max-width: calc(100vw - 24px); background: var(--surface); border-left: 1px solid var(--border);
        display: flex; flex-direction: column; z-index: 20; transform: translateX(100%);
        transition: transform 0.2s; overflow-y: auto;
      }
      .sidebar.open { transform: none; }
      .sidebar-section { padding: 14px; border-bottom: 1px solid var(--border); }
      .sidebar-section h4 { font-family: var(--font-title); font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 10px; }
      .token-list { display: flex; flex-direction: column; gap: 6px; }
      .token-item {
        display: flex; align-items: center; gap: 8px; padding: 7px 9px;
        border-radius: 7px; cursor: pointer; font-size: 13px; transition: background 0.15s;
      }
      .token-item:hover { background: rgba(30,33,28,0.08); }
      .token-item.selected { background: rgba(154,118,86,0.30); }
      .token-item.token-hidden { opacity: 0.55; }
      .token-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
      .token-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .icon-btn { background: none; border: none; cursor: pointer; color: var(--muted); font-size: 15px; padding: 5px; border-radius: 4px; }
      .icon-btn:hover { color: var(--text); background: rgba(30,33,28,0.08); }

      /* Token editor */
      .token-editor { padding: 14px; }
      .field { margin-bottom: 10px; }
      .field label { display: block; font-size: 11px; color: var(--muted); margin-bottom: 4px; }
      .field input[type=text], .field input[type=number] {
        width: 100%; padding: 7px 10px; background: var(--bg); border: 1px solid var(--border);
        border-radius: 6px; color: var(--text); font-size: 13px; outline: none;
      }
      .field input:focus { border-color: var(--accent); }
      .field-row { display: flex; gap: 8px; }
      .field-row .field { flex: 1; }
      .checkbox-row { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
      .checkbox-row input { cursor: pointer; }
      .color-input { width: 40px; height: 30px; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; background: none; padding: 2px; }
      .save-btn { width: 100%; padding: 8px; background: var(--brand); border: none; border-radius: 7px; color: var(--on-brand); font-size: 13px; font-weight: 600; cursor: pointer; margin-top: 4px; }
      .save-btn:hover { background: var(--brand-hover); }
      .del-btn { width: 100%; padding: 7px; background: transparent; border: 1px solid var(--danger); border-radius: 7px; color: var(--danger); font-size: 13px; cursor: pointer; margin-top: 6px; }
      .del-btn:hover { background: var(--danger); color: var(--on-brand); }

      /* Chat: dark ink glass so it stays readable over any map */
      .chat-wrap { position: absolute; bottom: 12px; left: 12px; width: min(280px, calc(100% - 24px)); z-index: 20; }
      .chat-messages {
        background: rgba(30,33,28,0.85); border: 1px solid rgba(216,208,189,0.25); border-radius: 8px;
        padding: 8px; max-height: 160px; overflow-y: auto; margin-bottom: 6px;
        font-size: 12px; display: flex; flex-direction: column; gap: 3px;
      }
      .chat-msg { color: #DCD4C1; }
      .chat-msg strong { color: #C89B7B; }
      .chat-input-row { display: flex; gap: 6px; }
      .chat-input {
        flex: 1; padding: 6px 10px; background: rgba(30,33,28,0.9); border: 1px solid rgba(216,208,189,0.25);
        border-radius: 6px; color: #DCD4C1; font-size: 16px; outline: none;
        /* 16px stops iOS Safari from auto-zooming the whole fixed layout on focus */
      }
      .chat-send { padding: 6px 12px; background: var(--brand); border: none; border-radius: 6px; color: var(--on-brand); cursor: pointer; font-size: 14px; }

      /* Notifications */
      .notif { position: absolute; top: 52px; left: 50%; transform: translateX(-50%);
        background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
        padding: 8px 16px; font-size: 13px; color: var(--text); z-index: 30;
        opacity: 0; transition: opacity 0.3s; pointer-events: none; }
      .notif.show { opacity: 1; }

      .toolbar-group { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
      .tool-btn {
        width: 36px; height: 36px; border-radius: 6px; border: 1px solid var(--border);
        background: transparent; color: var(--text); cursor: pointer; font-size: 15px;
        display: flex; align-items: center; justify-content: center; transition: background 0.15s;
        position: relative;
      }
      .tool-btn:hover { background: rgba(30,33,28,0.08); }
      .tool-btn.active { background: var(--brand); border-color: var(--brand); color: var(--on-brand); }
      /* Right-click context menu for doors, windows and stairs */
      .ctx-menu { position: absolute; z-index: 40; background: var(--surface); border: 1px solid var(--border);
        border-radius: 8px; box-shadow: 0 4px 16px rgba(30,33,28,0.25); padding: 4px; min-width: 180px; }
      .ctx-menu button { display: block; width: 100%; text-align: left; padding: 7px 12px; background: none;
        border: none; border-radius: 6px; cursor: pointer; color: var(--text); font-size: 13px; }
      .ctx-menu button:hover { background: rgba(30,33,28,0.08); }
      .ctx-menu .ctx-err { color: var(--danger); }

      .tool-btn[title]:hover::after {
        content: attr(title); position: absolute; bottom: -28px; left: 50%; transform: translateX(-50%);
        background: #1E211C; color: #D8D0BD; padding: 3px 7px; border-radius: 4px; font-size: 11px;
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
          <select class="header-btn" id="floor-select" title="Active floor"
                  style="max-width:150px;font-weight:600;display:none"></select>
          <div class="header-sep" id="floor-sep" style="display:none"></div>
          <div class="toolbar-group" id="tools"></div>
          ${isAdmin ? `<div class="header-sep" id="mode-sep"></div>
          <button class="header-btn" id="mode-btn" title="Toggle Build mode (B)">🔨 Build</button>` : ''}
          ${isAdmin ? `<div class="header-sep"></div>
          <button class="header-btn" id="snap-btn">Snap ✓</button>
          <button class="header-btn" id="grid-btn">Grid ✓</button>` : ''}
          ${isAdmin ? `<button class="header-btn" id="fog-toggle-btn">Fog ✓</button>
          <button class="header-btn" id="share-measure-btn" title="Share measurements with players">Share ✗</button>
          <button class="header-btn" id="focus-btn" title="Focus every display on your current view (one time)">🎯 Focus</button>` : ''}
        </div>
        <div class="game-header-right">
          ${isAdmin ? `<button class="header-btn" id="add-token-btn">+ Token</button>
          <button class="header-btn" id="clear-fog-btn">Clear Fog</button>
          <button class="header-btn" id="share-btn" title="Invite users to this map">👥 Share</button>` : ''}
          <button class="header-btn" id="music-btn" title="Music player">🎵</button>
          <button class="header-btn" id="sidebar-btn">Tokens ≡</button>
          <button class="header-btn" id="zen-btn" title="Fullscreen — hide menus (Esc to exit)">⛶</button>
          <span style="font-size:12px;color:var(--muted)">${esc(user.username)}</span>
        </div>
      </div>

      <div class="canvas-wrap" id="canvas-wrap">
        <canvas id="canvas-main"></canvas>
        <canvas id="canvas-fog"></canvas>
        <canvas id="canvas-ui"></canvas>

        <div class="music-panel" id="music-panel">
          <div class="sidebar-section" style="display:flex;align-items:center;justify-content:space-between;">
            <span style="font-family:var(--font-title);font-size:15px;font-weight:600;color:var(--text);">Music</span>
            <button class="icon-btn" id="music-close">✕</button>
          </div>
          <div style="padding:12px 14px;display:flex;flex-direction:column;gap:10px;border-bottom:1px solid var(--border);">
            <div id="music-now" style="font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Nothing playing</div>
            <div style="display:flex;align-items:center;gap:6px;">
              <button class="icon-btn" id="music-prev" title="Previous" style="font-size:16px;">⏮</button>
              <button class="icon-btn" id="music-play" title="Play / Pause" style="font-size:16px;">▶</button>
              <button class="icon-btn" id="music-next" title="Next" style="font-size:16px;">⏭</button>
              <span style="font-size:12px;color:var(--muted);">🔊</span>
              <input type="range" id="music-vol" min="0" max="1" step="0.05" style="flex:1;accent-color:#4D5947;" title="Volume" />
            </div>
          </div>
          <div class="sidebar-section">
            <h4>Queue</h4>
            <div id="music-queue" style="display:flex;flex-direction:column;gap:4px;"></div>
          </div>
        </div>

        <div class="sidebar" id="share-panel"></div>

        <div class="sidebar" id="sidebar">
          <div class="sidebar-section">
            <h4>Tokens</h4>
            <div class="token-list" id="token-list"></div>
            ${isAdmin ? `<button class="header-btn" style="width:100%;margin-top:8px;text-align:center" id="add-token-sidebar">+ Add Token</button>` : ''}
          </div>
          <div id="token-editor"></div>
        </div>

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
  const initialFloors = (table.floors ?? []) as FloorLite[]
  const state: GameState = {
    table: { ...table, ...floorFields(initialFloors[0] as Floor | undefined) },
    floors: initialFloors,
    floor: initialFloors[0] as Floor | null ?? null,
    stairs: [],
    tokens: [],
    fog: [],
    portals: [],
    walls: [],
    wallRecords: [] as WallRecord[],
    sightWalls: [],
    settings: { ...DEFAULT_TABLE_SETTINGS },
    camera: { x: 0, y: 0, zoom: 1 },
    mapImage: null,
    mapImagePath: '',
    fogOverview: null,
    activeTilesPath: '',
    exploredCanvas: null,
    selectedId: null,
    tool: 'select',
    mode: loadMode(table.id, isAdmin) as PageMode,
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

  /** False when a floor's pyramid turned out unusable — render falls back
   *  to the legacy full image until the floor changes. */
  let tilesUsable = true

  /** Bumped whenever the wall set changes (door/window toggles, reclassify,
   *  floor switches, table_state resync) — invalidates every cached LOS
   *  polygon in O(1). */
  let wallVersion = 0

  // ── Explored-fog memory, per floor ───────────────────────────────────────────
  // Only the active floor keeps a full-resolution explored canvas; other
  // floors hold a 1/8-scale mask (a few hundred KB each) so switching stays
  // lightweight no matter how many levels a table has.
  const FOG_MASK_SCALE = 8
  const exploredMasks = new Map<string, HTMLCanvasElement>()

  // Set whenever anything that feeds the explored memory changes (token
  // positions/sight, fog points, sight walls, floor switch). The render
  // loop stamps updateExplored only when dirty — recomputing LOS polygons
  // for every vision token on every frame was the top CPU cost while
  // panning/zooming, especially on phones.
  let exploredDirty = true
  function markExploredDirty() { exploredDirty = true }

  function stashExploredMask(floorId: string, explored: OffscreenCanvas | null) {
    if (!explored || !floorId) return
    const small = document.createElement('canvas')
    small.width = Math.max(1, Math.ceil(explored.width / FOG_MASK_SCALE))
    small.height = Math.max(1, Math.ceil(explored.height / FOG_MASK_SCALE))
    const sctx = small.getContext('2d')!
    sctx.imageSmoothingEnabled = true
    sctx.drawImage(explored, 0, 0, small.width, small.height)
    exploredMasks.set(floorId, small)
  }

  function restoreExploredMask(floorId: string, w: number, h: number): OffscreenCanvas {
    const full = new OffscreenCanvas(w, h)
    const mask = exploredMasks.get(floorId)
    if (mask) {
      const fctx = full.getContext('2d')!
      fctx.imageSmoothingEnabled = true
      fctx.drawImage(mask, 0, 0, w, h)
    }
    return full
  }

  function recomputeWalls() {
    // Wall rows are the single source of truth (UVTT metadata was migrated
    // into rows server-side). Portals still join per their semantics:
    // movement blocks on every closed portal; sight blocks on closed doors
    // only — a closed window stops movement but not vision.
    const staticWalls: WallSegment[] = state.wallRecords.map(w => ({ ax: w.ax, ay: w.ay, bx: w.bx, by: w.by }))
    state.walls = [...staticWalls, ...portalWalls(state.portals)]
    state.sightWalls = [...staticWalls, ...portalSightWalls(state.portals)]
    wallVersion++               // cached LOS polygons are now stale
    updateLosWorkerWalls(state.sightWalls, wallVersion)
    markExploredDirty()
  }

  /** Rebuild wall inputs after table_state already delivered fresh rows
   *  (walls ride along in the payload) or after a walls_update push. */
  function applyWallRecords(rows: WallRecord[]) {
    const fid = state.floor?.id ?? ''
    state.wallRecords = rows.filter(w => w.floor_id === fid)
    recomputeWalls()
  }

  /** Fetch wall rows for the table and rebuild LOS inputs (walls_update). */
  function refreshWalls() {
    api.listWalls(state.table.id)
      .then(rows => { applyWallRecords(rows); render() })
      .catch(() => { /* transient network error: keep current walls */ })
  }

  // Load map image (also re-run when a floor switch brings a new map path).
  // Tiled floors never load the full bitmap: the overview tile serves the
  // fog's greyscale phase and the pyramid renders the map itself.
  function loadMap() {
    const p = state.table.map_image_path ?? ''
    const tiled = !!state.floor?.tiles_path
    clearMapImageCache(tiled ? '' : p) // release every cached bitmap
    resetTileCache()
    state.fogOverview = null
    if (tiled) {
      // Fetch the single z0 overview tile for the fog's greyscale phase.
      // Its failure means the pyramid is unusable (deleted on disk, partial
      // write…) — fall back to the legacy full-image path.
      fetch(`${state.floor!.tiles_path}/0/0_0.jpg`)
        .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.blob() })
        .then(b => {
          if (!b.type.startsWith('image/')) throw new Error('not an image')
          return createImageBitmap(b)
        })
        .then(bmp => { state.fogOverview = bmp; markExploredDirty(); render() })
        .catch(() => { tilesUsable = false; tileFallback() })
      if (!tilesUsable) return tileFallback()
      state.mapImage = null
      state.mapImagePath = ''
      state.exploredCanvas = state.floor
        ? restoreExploredMask(state.floor.id, Math.ceil(state.floor.img_width / 4), Math.ceil(state.floor.img_height / 4))
        : null
      markExploredDirty()
      render()
      return
    }
    return tileFallback()

    function tileFallback() {
      if (!p || p === state.mapImagePath) return
      state.mapImagePath = p
      preloadMapImage(p, img => {
        if (state.table.map_image_path !== p) return // superseded by a newer map
        state.mapImage = img
        // Explored canvas lives in world space at the map's native resolution
        state.exploredCanvas = state.floor
          ? restoreExploredMask(state.floor.id, img.width, img.height)
          : new OffscreenCanvas(img.width, img.height)
        markExploredDirty()
        render()
      })
    }
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

      // Main canvas: map + grid + tokens. Tiles first: when the floor has a
      // pyramid, draw from the viewport-only LRU cache and never materialize
      // the full-resolution bitmap. Until the first tiles arrive (or on a
      // failed pyramid), fall back to the legacy full image.
      mainCtx.clearRect(0, 0, w, h)
      let mapDrawn = false
      if (tilesUsable && state.floor?.tiles_path && state.floor.img_width > 0 && state.floor.img_height > 0) {
        mapDrawn = drawTiledMap(
          mainCtx, state.floor.tiles_path, state.floor.img_width, state.floor.img_height,
          state.camera, state.table.map_offset_x ?? 0, state.table.map_offset_y ?? 0,
          () => render(),
          state.fogOverview,
        )
      }
      if (!mapDrawn) {
        drawMap(mainCtx, state.mapImage, state.camera, state.table.map_offset_x ?? 0, state.table.map_offset_y ?? 0)
      }
      if (state.gridVisible) {
        drawGrid(mainCtx, state.camera, state.table.grid_size ?? 70, w, h)
      }
      // Build mode: boost grid visibility for alignment work, dim tokens
      // (placement context only — not interactive) and draw the walls
      // overlay through the fog so walls act as editing handles.
      if (state.mode === 'build') {
        if (!state.gridVisible) drawGrid(mainCtx, state.camera, state.table.grid_size ?? 70, w, h)
        mainCtx.save()
        mainCtx.globalAlpha = 0.35
        drawTokens(mainCtx, visibleTokens, state.camera, state.table.grid_size ?? 70, null, user.username, isAdmin)
        mainCtx.restore()
        drawWallsOverlay(mainCtx, state.wallRecords, state.camera, selectedWalls)
        drawPortalsBuild(mainCtx, state.portals, state.camera)
      } else {
        drawTokens(mainCtx, visibleTokens, state.camera, state.table.grid_size ?? 70, state.selectedId, user.username, isAdmin)
      }
      if (hiddenTokens.length > 0 && state.mode !== 'build') {
        mainCtx.globalAlpha = 0.5
        drawTokens(mainCtx, hiddenTokens, state.camera, state.table.grid_size ?? 70, state.selectedId, user.username, isAdmin)
        mainCtx.globalAlpha = 1
      }
      if (state.mode !== 'build') {
        drawPortals(mainCtx, state.portals, state.camera, isAdmin)
        drawStairs(mainCtx, state.stairs, state.floors, state.camera, state.table.grid_size ?? 70, isAdmin)
      }

      // Fog canvas: punched only by the tokens each viewer can see (admins
      // see the sight of hidden tokens too)
      const sightTokens = isAdmin ? state.tokens : visibleTokens
      fogCtx.clearRect(0, 0, w, h)
      if (state.fogEnabled) {
        // Keep the explored memory up to date so areas that fall out of
        // sight keep showing in greyscale instead of going fully black.
        // Stamp only on change (dragging marks dirty per move); the map
        // itself is world-space, so panning/zooming never invalidates it.
        // Tiled floors run the mask at quarter scale (binary mask —
        // memory is the point of this path).
        const tiled = tilesUsable && !!state.floor?.tiles_path
        const maskScale = tiled ? 0.25 : 1
        // While dragging, sight follows the pointer in ~4px steps — a fresh
        // exact polygon is computed on release (finishTokenDrag marks dirty
        // with quantum 0).
        const dragging = state.dragging
        if (state.exploredCanvas && exploredDirty) {
          updateExplored(state.exploredCanvas, sightTokens, state.fog, state.sightWalls, state.table.grid_size ?? 70, maskScale, wallVersion, dragging ? DRAG_QUANTUM : 0)
          exploredDirty = false
        }
        const fogSource = tiled ? state.fogOverview : state.mapImage
        drawFog(
          fogCtx, sightTokens, state.fog, state.sightWalls, state.camera, state.table.grid_size ?? 70, isAdmin,
          state.exploredCanvas, fogSource,
          state.table.map_offset_x ?? 0, state.table.map_offset_y ?? 0,
          tiled ? state.floor!.img_width : undefined,
          tiled ? state.floor!.img_height : undefined,
          wallVersion, dragging ? DRAG_QUANTUM : 0,
        )
      }

      // UI canvas: shared (admin) measurement, then the local measuring tool
      uiCtx.clearRect(0, 0, w, h)
      if (state.mode === 'build' && isAdmin) {
        if (buildDrag === 'draw') drawWallGhost(uiCtx, drawStart.x, drawStart.y, drawEnd.x, drawEnd.y, state.camera)
        if (buildDrag === 'marquee') drawMarquee(uiCtx, marqueeStart.x, marqueeStart.y, marqueeEnd.x, marqueeEnd.y)
      }
      const unitSize = state.settings.grid_square_size
      const unit = state.settings.measurement_unit
      if (state.sharedMeasure) {
        drawMeasure(uiCtx, state.sharedMeasure, state.camera, state.table.grid_size ?? 70, unitSize, unit)
      }
      drawMeasure(uiCtx, state.measure, state.camera, state.table.grid_size ?? 70, unitSize, unit)
    })
  }
  resizeCanvases()
  new ResizeObserver(resizeCanvases).observe(wrap)

  // LOS worker: heavy polygon computes leave the main thread during drags.
  // Results repaint; misses keep drawing the previous polygon meanwhile.
  recomputeWalls() // establishes state.sightWalls + wallVersion 1
  initLosWorker(state.sightWalls, wallVersion)
  setLosResultHandler(res => {
    // storeWorkerPolygon equivalent lives in layers; trigger a repaint here
    applyLosResult(res.key, res.version, res.poly)
    markExploredDirty()
    render()
  })

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
          markExploredDirty()
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

  // Shared image library for the token editor (fetched once per page)
  let imageAssets: Asset[] = []
  let imageAssetsLoaded = false

  function renderTokenEditor() {
    const editorEl = root.querySelector('#token-editor') as HTMLElement
    if (!isAdmin) { editorEl.innerHTML = ''; return }
    const token = state.tokens.find(t => t.id === state.selectedId)
    if (!token) { editorEl.innerHTML = ''; return }

    // Load the shared image list in the background, then re-render
    if (!imageAssetsLoaded) {
      imageAssetsLoaded = true
      api.listAssets('image')
        .then(list => { imageAssets = list; renderTokenEditor() })
        .catch(() => {})
    }

    editorEl.innerHTML = `
      <div class="token-editor">
        <div class="field"><label>Name</label><input type="text" id="te-name" value="${esc(token.name)}" /></div>
        <div class="field-row">
          <div class="field"><label>Size (sq)</label><input type="number" id="te-size" value="${token.size}" min="0.5" max="6" step="0.5" /></div>
          <div class="field"><label>Color</label><input type="color" class="color-input" id="te-color" value="${token.color}" /></div>
        </div>
        <div class="field"><label>Owner (username)</label><input type="text" id="te-owner" value="${esc(token.owner)}" /></div>
        <div class="field"><label>Floor</label>
          <select id="te-floor">
            ${state.floors.map(f => `<option value="${f.id}" ${token.floor_id === f.id ? 'selected' : ''}>${esc(floorLabel(f))}</option>`).join('')}
          </select>
        </div>
        <label class="checkbox-row">
          <input type="checkbox" id="te-vision" ${token.has_vision ? 'checked' : ''} />
          Has Vision
        </label>
        <label class="checkbox-row" style="margin-top:6px">
          <input type="checkbox" id="te-hidden" ${token.hidden ? 'checked' : ''} />
          Hidden from players
        </label>
        <div class="field" style="margin-top:8px"><label>Vision Radius (sq)</label><input type="number" id="te-vrad" value="${token.vision_radius}" min="1" max="60" /></div>
        <div class="field"><label>Shared image</label>
          <select id="te-icon-pick">
            <option value="">— none / custom —</option>
            ${imageAssets.map(a => `<option value="${esc(a.path)}" ${token.icon_path === a.path ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Icon URL / path</label><input type="text" id="te-icon" value="${esc(token.icon_path)}" /></div>
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;margin-bottom:10px">
          <input type="file" id="te-icon-file" accept="image/*" style="display:none" />
          <button class="header-btn" id="te-icon-upload-btn" style="font-size:12px">Upload icon</button>
        </label>
        <button class="save-btn" id="te-save">Save Token</button>
        <button class="del-btn" id="te-del">Delete Token</button>
      </div>
    `

    root.querySelector('#te-icon-pick')?.addEventListener('change', (e) => {
      const path = (e.target as HTMLSelectElement).value
      const iconInput = root.querySelector('#te-icon') as HTMLInputElement
      if (path) iconInput.value = path
    })
    root.querySelector('#te-icon-upload-btn')?.addEventListener('click', () => {
      (root.querySelector('#te-icon-file') as HTMLInputElement).click()
    })
    root.querySelector('#te-icon-file')?.addEventListener('change', async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return
      try {
        // Upload into the shared library (deduplicated by content) and use
        // the resulting path for this token
        const asset = await api.uploadAsset(file, 'image')
        if (!imageAssets.some(a => a.id === asset.id)) imageAssets.push(asset)
        ;(root.querySelector('#te-icon') as HTMLInputElement).value = asset.path
        const pick = root.querySelector('#te-icon-pick') as HTMLSelectElement | null
        if (pick) {
          pick.innerHTML = `<option value="">— none / custom —</option>` +
            imageAssets.map(a => `<option value="${esc(a.path)}" ${a.path === asset.path ? 'selected' : ''}>${esc(a.name)}</option>`).join('')
        }
        preloadTokenImage(asset.path)
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
        floor_id: (root.querySelector('#te-floor') as HTMLSelectElement)?.value ?? token.floor_id,
      }
      await api.updateToken(state.table.id, token.id, updated)
      if (updated.floor_id && updated.floor_id !== state.floor?.id) {
        // Moved to another floor by the editor: our display follows it
        switchFloor(updated.floor_id)
        return
      } else {
        const idx = state.tokens.findIndex(t => t.id === token.id)
        if (idx !== -1) state.tokens[idx] = updated
        if (updated.icon_path) preloadTokenImage(updated.icon_path)
        socket.send('token_update', { token: updated })
        markExploredDirty()
      }
      refreshSidebar()
      render()
    })

    root.querySelector('#te-del')?.addEventListener('click', async () => {
      if (!confirm('Delete this token?')) return
      await api.deleteToken(state.table.id, token.id)
      socket.send('token_delete', { token_id: token.id })
      state.tokens = state.tokens.filter(t => t.id !== token.id)
      state.selectedId = null
      markExploredDirty()
      renderTokenEditor()
      refreshSidebar()
      render()
    })
  }

  // ── Floor switching ──────────────────────────────────────────────────────────
  // Optimistic: apply locally (clear floor-scoped data, reload the single
  // bitmap) and tell the server, which confirms with a fresh table_state.

  function applyFloor(floor: FloorLite) {
    // Stash the old floor's explored memory, then drop it: each level keeps
    // its own sight history, nothing is transposed across the switch.
    if (state.floor) stashExploredMask(state.floor.id, state.exploredCanvas)
    state.floor = floor as Floor
    state.table = { ...state.table, ...floorFields(floor as Floor) }
    state.tokens = []
    state.fog = []
    state.portals = []
    state.stairs = []
    state.selectedId = null
    state.mapImage = null
    state.mapImagePath = '' // force the new floor's bitmap to load
    tilesUsable = true      // re-try the pyramid on the new floor
    state.exploredCanvas = null
    recomputeWalls()
    loadMap()
    refreshSidebar()
    renderTokenEditor()
    updateFloorSelect()
    render()
  }

  function switchFloor(floorId: string) {
    const target = state.floors.find(f => f.id === floorId)
    if (!target || target.id === state.floor?.id) return
    socket.send('floor_select', { floor_id: floorId })
    applyFloor(target)
  }

  function updateFloorSelect() {
    const sel = root.querySelector('#floor-select') as HTMLElement | null
    const sep = root.querySelector('#floor-sep') as HTMLElement | null
    if (!sel) return
    if (state.floors.length < 2) {
      sel.style.display = 'none'
      if (sep) sep.style.display = 'none'
      return
    }
    sel.style.display = ''
    if (sep) sep.style.display = ''
    sel.innerHTML = state.floors
      .map(f => `<option value="${f.id}" ${f.id === state.floor?.id ? 'selected' : ''}>${esc(floorLabel(f))}</option>`)
      .join('')
  }

  root.querySelector('#floor-select')?.addEventListener('change', (e) => {
    switchFloor((e.target as HTMLSelectElement).value)
  })
  updateFloorSelect()

  // WebSocket
  const token = localStorage.getItem('token') ?? ''
  socket.connect(table.id, token)
  let initialStateLoaded = false

  const unsub = socket.on((msg) => {
    switch (msg.type) {
      case 'table_state': {
        const p = msg.payload as TableStatePayload
        if (p.map_role) setMapRole(p.map_role)
        const oldFloorId = state.floor?.id
        state.floors = p.floors ?? []
        state.floor = p.floor
        state.table = { ...state.table, ...p.table, ...floorFields(p.floor) }
        state.tokens = p.tokens ?? []
        state.fog = p.fog ?? []
        state.portals = p.portals ?? []
        state.stairs = p.stairs ?? []
        if (p.walls) applyWallRecords(p.walls)
        markExploredDirty()
        const floorChanged = !!p.floor && p.floor.id !== oldFloorId
        const tilesPath = state.floor?.tiles_path ?? ''
        if (floorChanged) {
          // Server-driven floor change (e.g. our viewed floor was deleted):
          // keep the old floor's explored memory, then load the new level.
          if (oldFloorId) stashExploredMask(oldFloorId, state.exploredCanvas)
          state.mapImage = null
          state.mapImagePath = ''
          tilesUsable = true // new floor: pyramid retry
          state.exploredCanvas = null
          state.activeTilesPath = tilesPath
          loadMap()
        } else if (tilesPath && tilesPath !== state.activeTilesPath) {
          // Same floor but its pyramid just appeared (lazy backfill push):
          // switch to tiles. Plain state pushes (token moves, toggles, fog)
          // must NOT wipe the tile cache — that refetches the whole viewport
          // on every push (request storm + flicker).
          state.activeTilesPath = tilesPath
          loadMap()
        }
        if (p.settings) state.settings = { ...DEFAULT_TABLE_SETTINGS, ...p.settings }
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
        updateFloorSelect()
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
      case 'walls_update': {
        // Any wall mutation: refetch rows for this floor (cheap: one GET)
        refreshWalls()
        break
      }
      case 'settings_update': {
        const p = msg.payload as { settings: TableSettings }
        state.settings = { ...DEFAULT_TABLE_SETTINGS, ...p.settings }
        // An admin changed the global defaults: apply them live to the view
        state.gridVisible = state.settings.grid_visible_default
        state.fogEnabled = state.settings.fog_enabled_default
        state.snap = state.settings.snap_default
        applySettings()
        break
      }
      case 'token_move': {
        const p = msg.payload as TokenMovePayload
        const t = state.tokens.find(t => t.id === p.token_id)
        if (t) { t.x = p.x; t.y = p.y; markExploredDirty(); render() }
        break
      }
      case 'token_update': {
        const p = msg.payload as TokenUpdatePayload
        if (p.token.floor_id && state.floor && p.token.floor_id !== state.floor.id) {
          // Token lives on another floor — it can only be a removal for us
          state.tokens = state.tokens.filter(t => t.id !== p.token.id)
          if (state.selectedId === p.token.id) { state.selectedId = null; renderTokenEditor() }
          markExploredDirty()
          refreshSidebar()
          render()
          break
        }
        const idx = state.tokens.findIndex(t => t.id === p.token.id)
        if (idx !== -1) {
          state.tokens[idx] = p.token
        } else {
          state.tokens.push(p.token)  // token created while we were connected
        }
        if (p.token.icon_path) preloadTokenImage(p.token.icon_path)
        markExploredDirty()
        refreshSidebar()
        render()
        break
      }
      case 'token_delete': {
        const p = msg.payload as TokenDeletePayload
        state.tokens = state.tokens.filter(t => t.id !== p.token_id)
        if (state.selectedId === p.token_id) state.selectedId = null
        markExploredDirty()
        refreshSidebar()
        render()
        break
      }
      case 'fog_update': {
        const p = msg.payload as FogUpdatePayload
        if (p.action === 'clear_all') {
          // clear_all may carry the surviving points (erase tool)
          state.fog = p.points ?? []
        } else if (p.action === 'add') {
          state.fog.push(...p.points)
        }
        markExploredDirty()
        render()
        break
      }
      case 'measure_update': {
        const p = msg.payload as MeasureUpdatePayload & { floor_id?: string }
        // Shared measurements belong to the floor they were drawn on
        if (p.floor_id && state.floor && p.floor_id !== state.floor.id) break
        state.sharedMeasure = p.measure
        render()
        break
      }
      case 'music_state': {
        state.music = msg.payload as MusicStatePayload
        applyMusicState()
        break
      }
      case 'camera_focus': {
        // One-time admin focus: adopt the admin's floor, camera and zoom
        const p = msg.payload as { x: number; y: number; zoom: number; floor_id?: string }
        if (p.floor_id && p.floor_id !== state.floor?.id) switchFloor(p.floor_id)
        state.camera = { x: p.x, y: p.y, zoom: p.zoom }
        render()
        showNotif('The admin focused your view')
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
    }).join('') || '<div style="font-size:12px;color:var(--muted);">No music uploaded yet</div>'

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

  // ── Share panel (dm): invite users as player or dm ───────────────────────────
  const sharePanel = root.querySelector('#share-panel') as HTMLElement | null
  let membersLoaded = false

  async function renderSharePanel() {
    if (!sharePanel) return
    let members: MapMember[] = []
    try { members = await api.listMembers(state.table.id) } catch { /* keep empty */ }
    sharePanel.innerHTML = `
      <div class="sidebar-section" style="display:flex;align-items:center;justify-content:space-between">
        <span style="font-family:var(--font-title);font-size:15px;font-weight:600;color:var(--text)">Share this map</span>
        <button class="icon-btn" id="share-close">✕</button>
      </div>
      <div class="sidebar-section">
        <h4>Invite a user</h4>
        <div class="field-row" style="align-items:flex-end">
          <div class="field" style="flex:1"><label>Username</label><input type="text" id="share-user" placeholder="username" /></div>
          <div class="field"><label>Role</label>
            <select id="share-role">
              <option value="player">player</option>
              <option value="dm">dm</option>
            </select>
          </div>
        </div>
        <button class="save-btn" id="share-add" style="margin-top:8px">Invite</button>
        <div class="msg" id="share-msg"></div>
      </div>
      <div class="sidebar-section">
        <h4>Members (${members.length})</h4>
        <div class="token-list">
          ${members.map(m => `
            <div class="token-item" style="cursor:default">
              <span style="font-size:13px;flex:1">${esc(m.username)}</span>
              <span class="badge ${m.role === 'dm' ? 'badge-admin' : 'badge-player'}" style="text-transform:none">${m.role}</span>
              ${m.username === user.username ? '' : `<button class="icon-btn" data-unmember="${esc(m.username)}" title="Remove">✕</button>`}
            </div>`).join('')}
        </div>
        <span style="font-size:11px;color:var(--muted)">Dms manage everything on the map; players move their own tokens and open doors/windows per the map settings.</span>
      </div>
    `
    const msg = sharePanel.querySelector('#share-msg') as HTMLElement
    sharePanel.querySelector('#share-close')!.addEventListener('click', () => sharePanel.classList.remove('open'))
    sharePanel.querySelector('#share-add')!.addEventListener('click', async () => {
      const username = (sharePanel.querySelector('#share-user') as HTMLInputElement).value.trim()
      const role = (sharePanel.querySelector('#share-role') as HTMLSelectElement).value as 'dm' | 'player'
      if (!username) { msg.textContent = 'Enter a username'; msg.className = 'msg msg-err'; return }
      try {
        await api.addMember(state.table.id, username, role)
        msg.textContent = `${username} invited as ${role}`; msg.className = 'msg msg-ok'
        setTimeout(renderSharePanel, 600)
      } catch (e: any) { msg.textContent = e.message; msg.className = 'msg msg-err' }
    })
    sharePanel.querySelectorAll('[data-unmember]').forEach(el => {
      el.addEventListener('click', async () => {
        const username = (el as HTMLElement).dataset.unmember!
        if (!confirm(`Remove ${username} from this map?`)) return
        try { await api.removeMember(state.table.id, username); renderSharePanel() }
        catch (e: any) { showNotif(e.message) }
      })
    })
  }

  root.querySelector('#share-btn')?.addEventListener('click', () => {
    if (!sharePanel) return
    root.querySelector('#sidebar')?.classList.remove('open')
    sharePanel.classList.toggle('open')
    if (sharePanel.classList.contains('open') && !membersLoaded) {
      membersLoaded = true
      void renderSharePanel()
    }
  })

  root.querySelector('#music-btn')?.addEventListener('click', () => {
    root.querySelector('#sidebar')?.classList.remove('open')
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
    root.querySelector('#share-panel')?.classList.remove('open')
    root.querySelector('#sidebar')!.classList.toggle('open')
  })

  // Fullscreen (zen) mode — hide every menu AND take the browser fullscreen.
  // Esc exits the browser fullscreen natively; fullscreenchange brings the
  // menus back.
  const gameRoot = root.querySelector('.game') as HTMLElement

  function closeAllPanels() {
    root.querySelector('#share-panel')?.classList.remove('open')
    root.querySelector('#sidebar')?.classList.remove('open')
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

  function applySettings() {
    // Chat visibility only. Grid/Fog/Snap are user view toggles: they take
    // their default on join and when an admin changes the global defaults
    // (settings_update), but never from routine table_state pushes.
    const chatWrap = root.querySelector('#chat-wrap') as HTMLElement | null
    if (chatWrap) chatWrap.style.display = state.settings.chat_enabled ? '' : 'none'
    updateHeaderToggles()
    render()
  }

  // ── Mode-aware toolbar ──────────────────────────────────────────────────────

  /** Render the toolbar for the active mode. Build tools only exist in
   *  build mode; play tools only in play mode — they never share a
   *  toolbar or a gesture. */
  function toolBtn(tool: ToolType, label: string, title: string): string {
    const active = state.tool === tool ? ' active' : ''
    return `<button class="tool-btn${active}" data-tool="${tool}" title="${title}">${label}</button>`
  }
  function renderToolbar() {
    const group = root.querySelector('#tools') as HTMLElement | null
    if (!group) return
    const sep = '<div class="header-sep"></div>'
    const play = [
      toolBtn('select', '↖', 'Select/Move (S)'),
      toolBtn('line', '╱', 'Measure Line (L)'),
      toolBtn('circle', '◯', 'Measure Circle (C)'),
      toolBtn('square', '▭', 'Measure Square (Q)'),
      toolBtn('cone', '◤', 'Measure Cone (N)'),
    ]
    if (isAdmin) play.push(sep, toolBtn('fog-reveal', '👁', 'Reveal Fog (R)'), toolBtn('fog-erase', '🌑', 'Erase Revealed (E)'), sep, toolBtn('stairs', '🪜', 'Place stairs to another floor'))
    const build = [
      toolBtn('wall-select', '⬚', 'Select/Move Walls (W)'),
      toolBtn('wall', '╱', 'Draw Wall (D)'),
      toolBtn('wall-erase', '⌫', 'Erase Wall (X)'),
      sep,
      toolBtn('door', '🚪', 'Place Door (O)'),
      toolBtn('window', '🪟', 'Place Window (J)'),
      sep,
      toolBtn('grid-setup', '▦', 'Grid Setup (G)'),
    ]
    group.innerHTML = (state.mode === 'build' ? build : play).join('')
    group.querySelectorAll('[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.tool = (btn as HTMLElement).dataset.tool as ToolType
        renderToolbar()
      })
    })
  }
  renderToolbar()

  /** Switch build ⇄ play. Cancels any active gesture and swaps the toolbar. */
  function setMode(mode: PageMode) {
    if (state.mode === mode) return
    state.mode = mode
    saveMode(table.id, mode)
    state.tool = mode === 'build' ? 'wall-select' : 'select'
    state.selectedId = null
    state.measure.active = false
    state.dragging = false
    state.panning = false
    renderToolbar()
    updateModeBtn()
    render()
  }

  /** Update the 🔨/🎲 button label to the mode you'd switch TO. */
  function updateModeBtn() {
    const btn = root.querySelector('#mode-btn') as HTMLButtonElement | null
    if (!btn) return
    btn.textContent = state.mode === 'build' ? '🎲 Play' : '🔨 Build'
    btn.title = state.mode === 'build' ? 'Back to Play mode (B)' : 'Toggle Build mode (B)'
  }
  updateModeBtn()
  root.querySelector('#mode-btn')?.addEventListener('click', () => {
    setMode(state.mode === 'build' ? 'play' : 'build')
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

  // Focus: one-time snap of every display to the admin's view (floor,
  // camera, zoom). Not a continuous follow — clients stay free afterwards.
  const focusBtn = root.querySelector('#focus-btn') as HTMLButtonElement
  focusBtn?.addEventListener('click', () => {
    socket.send('camera_focus', {
      x: state.camera.x, y: state.camera.y, zoom: state.camera.zoom,
      floor_id: state.floor?.id,
    })
    showNotif('Your view has been sent to everyone')
  })

  // Share measurements with players (admin)
  const shareBtn = root.querySelector('#share-measure-btn') as HTMLButtonElement
  shareBtn?.addEventListener('click', () => {
    state.shareMeasure = !state.shareMeasure
    if (!state.shareMeasure) {
      state.sharedMeasure = null
      socket.send('measure_update', { measure: null, floor_id: state.floor?.id })
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
    if (!confirm('Clear all manually revealed fog on this floor?')) return
    await api.clearFog(table.id, state.floor?.id)
    socket.send('fog_update', { action: 'clear_all', points: [], floor_id: state.floor?.id })
    state.fog = []
    markExploredDirty()
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
        size: 0.75, color: randomColor(), has_vision: false, vision_radius: 6,
        floor_id: state.floor?.id,
      })
      state.tokens.push(newToken)
      state.selectedId = newToken.id
      socket.send('token_update', { token: newToken })
      markExploredDirty()
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

  // ── Build-mode wall tools (M1.2) ─────────────────────────────────────────────

  /** Selected wall ids (build mode). */
  const selectedWalls = new Set<string>()
  /** What the left button is doing in build mode. */
  let buildDrag: 'none' | 'draw' | 'marquee' | 'move' | 'endpoint' = 'none'
  /** Draw start (world) + current ghost end. */
  let drawStart = { x: 0, y: 0 }
  let drawEnd = { x: 0, y: 0 }
  /** Marquee corners (screen). */
  let marqueeStart = { x: 0, y: 0 }
  let marqueeEnd = { x: 0, y: 0 }
  /** Wall-move drag bookkeeping (world). */
  let moveOrigin = { x: 0, y: 0 }
  let moveLast = { x: 0, y: 0 }
  /** Endpoint-drag: which wall + endpoint + its original position. */
  let endpointDrag: { wall: WallRecord; end: 'a' | 'b' } | null = null
  /** Start positions of the selected group (world px) for live previews. */
  let groupStartPositions = new Map<string, { ax: number; ay: number; bx: number; by: number }>()

  const buildTol = () => Math.max(8 / state.camera.zoom, (state.table.grid_size ?? 70) * 0.12)
  const buildSnap = (v: number) => (state.snap ? snapToGrid(v, state.table.grid_size ?? 70) : v)

  function buildMouseDown(sx: number, sy: number, wx: number, wy: number, shiftKey: boolean) {
    const tol = buildTol()
    if (state.tool === 'wall') {
      buildDrag = 'draw'
      drawStart = { x: buildSnap(wx), y: buildSnap(wy) }
      drawEnd = { ...drawStart }
      return
    }
    if (state.tool === 'wall-erase') {
      eraseWallAt(wx, wy, tol)
      return
    }
    if (state.tool === 'door' || state.tool === 'window') {
      buildDrag = 'draw'   // reuse the draw gesture; commit creates a portal
      drawStart = { x: buildSnap(wx), y: buildSnap(wy) }
      drawEnd = { ...drawStart }
      return
    }
    if (state.tool === 'grid-setup') {
      openGridSetup()
      return
    }
    if (state.tool === 'wall-select') {
      selectWallAt(sx, sy, wx, wy, tol, shiftKey)
      return
    }
    // door/window/grid-setup: M1.3+
    startPan(sx, sy)
    uiCanvas.style.cursor = 'grabbing'
  }

  /** wall-erase tool: delete the wall (or portal) under the cursor. */
  function eraseWallAt(wx: number, wy: number, tol: number) {
    const portal = pickPortalBuild(state.portals, wx, wy, tol)
    if (portal) {
      api.deletePortal(state.table.id, portal.id).catch(() => showNotif('Delete failed'))
      state.portals = state.portals.filter(p => p.id !== portal.id)
      recomputeWalls()
      render()
      return
    }
    const hit = pickWall(state.wallRecords, wx, wy, tol)
    if (!hit) return
    api.deleteWall(hit.wall.id).catch(() => showNotif('Delete failed'))
    state.wallRecords = state.wallRecords.filter(w => w.id !== hit.wall.id)
    selectedWalls.delete(hit.wall.id)
    recomputeWalls()
    render()
  }

  /** wall-select tool: pick a wall (drag body = move, drag endpoint = edit)
   *  or start a marquee on empty space. */
  function selectWallAt(sx: number, sy: number, wx: number, wy: number, tol: number, shiftKey: boolean) {
    const hit = pickWall(state.wallRecords, wx, wy, tol)
    if (!hit) {
      // Empty press: start a marquee (shift keeps the current selection)
      if (!shiftKey) selectedWalls.clear()
      buildDrag = 'marquee'
      marqueeStart = { x: sx, y: sy }
      marqueeEnd = { x: sx, y: sy }
      render()
      return
    }
    if (!shiftKey && !selectedWalls.has(hit.wall.id)) selectedWalls.clear()
    selectedWalls.add(hit.wall.id)
    if (hit.grab === 'body') {
      buildDrag = 'move'
      moveOrigin = { x: wx, y: wy }
      moveLast = { ...moveOrigin }
      groupStartPositions = new Map(state.wallRecords
        .filter(w => selectedWalls.has(w.id))
        .map(w => [w.id, { ax: w.ax, ay: w.ay, bx: w.bx, by: w.by }]))
    } else {
      buildDrag = 'endpoint'
      endpointDrag = { wall: hit.wall, end: hit.grab }
    }
    render()
  }

  function buildMouseMove(sx: number, sy: number) {
    if (buildDrag === 'none') return
    const [wx, wy] = screenToWorld(sx, sy, state.camera)
    if (buildDrag === 'draw') {
      drawEnd = { x: buildSnap(wx), y: buildSnap(wy) }
      render()
      return
    }
    if (buildDrag === 'marquee') {
      marqueeEnd = { x: sx, y: sy }
      render()
      return
    }
    if (buildDrag === 'move') {
      previewGroupMove(wx, wy)
      return
    }
    if (buildDrag === 'endpoint' && endpointDrag) {
      previewEndpointMove(endpointDrag, wx, wy)
    }
  }

  /** Live group-move preview: incremental deltas on current positions. */
  function previewGroupMove(wx: number, wy: number) {
    const dx = wx - moveLast.x, dy = wy - moveLast.y
    moveLast = { x: wx, y: wy }
    for (const w of state.wallRecords) {
      if (!groupStartPositions.has(w.id)) continue
      w.ax += dx; w.ay += dy
      w.bx += dx; w.by += dy
    }
    recomputeWallsPreview()
    render()
  }

  /** Live endpoint-drag preview (grid-snapped). */
  function previewEndpointMove(ep: { wall: WallRecord; end: 'a' | 'b' }, wx: number, wy: number) {
    const w = state.wallRecords.find(x => x.id === ep.wall.id)
    if (!w) return
    if (ep.end === 'a') { w.ax = buildSnap(wx); w.ay = buildSnap(wy) }
    else { w.bx = buildSnap(wx); w.by = buildSnap(wy) }
    recomputeWallsPreview()
    render()
  }

  /** Recompute LOS inputs for the live preview without a server round-trip.
   *  recomputeWalls() itself is idempotent; the explored stamp stays as-is
   *  during the drag (it refreshes via markExploredDirty on commit). */
  function recomputeWallsPreview() {
    const staticWalls: WallSegment[] = state.wallRecords.map(w => ({ ax: w.ax, ay: w.ay, bx: w.bx, by: w.by }))
    state.walls = [...staticWalls, ...portalWalls(state.portals)]
    state.sightWalls = [...staticWalls, ...portalSightWalls(state.portals)]
    wallVersion++
    updateLosWorkerWalls(state.sightWalls, wallVersion)
  }

  function buildMouseUp(sx: number, sy: number) {
    if (buildDrag === 'draw') {
      commitWallDraw()
      return
    }
    if (buildDrag === 'marquee') {
      commitMarquee()
      return
    }
    if (buildDrag === 'move') {
      commitGroupMove()
      return
    }
    if (buildDrag === 'endpoint' && endpointDrag) {
      commitEndpointMove(endpointDrag)
    }
  }

  /** Finish a wall draw: create the segment if it is long enough. */
  function commitWallDraw() {
    const ax = drawStart.x, ay = drawStart.y
    const bx = drawEnd.x, by = drawEnd.y
    buildDrag = 'none'
    if (Math.hypot(bx - ax, by - ay) < 4) { render(); return } // ignore micro-drags
    if (state.tool === 'door' || state.tool === 'window') {
      api.createPortal(state.table.id, {
        floor_id: state.floor?.id ?? '',
        x1: ax, y1: ay, x2: bx, y2: by,
        kind: state.tool, closed: true,
      }).catch(() => showNotif('Portal create failed'))
      return
    }
    api.createWall(state.table.id, state.floor?.id ?? '', { ax, ay, bx, by })
      .catch(() => showNotif('Wall create failed'))
    // walls_update push refreshes every client including us
  }

  /** Finish a marquee: select every wall intersecting the rect. */
  function commitMarquee() {
    buildDrag = 'none'
    const [wx0, wy0] = screenToWorld(marqueeStart.x, marqueeStart.y, state.camera)
    const [wx1, wy1] = screenToWorld(marqueeEnd.x, marqueeEnd.y, state.camera)
    const hits = wallsInRect(state.wallRecords, wx0, wy0, wx1, wy1)
    for (const h of hits) selectedWalls.add(h.id)
    render()
  }

  /** Finish a group move: restore local starts, send one batch delta. */
  function commitGroupMove() {
    buildDrag = 'none'
    const dx = moveLast.x - moveOrigin.x, dy = moveLast.y - moveOrigin.y
    if (dx === 0 && dy === 0) { render(); return }
    // Restore local records to their start (server is the truth; the
    // walls_update push re-applies the authoritative moved positions)
    for (const w of state.wallRecords) {
      const start = groupStartPositions.get(w.id)
      if (!start) continue
      w.ax = start.ax; w.ay = start.ay; w.bx = start.bx; w.by = start.by
    }
    recomputeWallsPreview()
    api.moveWalls(state.table.id, [...selectedWalls], dx, dy)
      .catch(() => showNotif('Wall move failed'))
    render()
  }

  /** Finish an endpoint drag: persist the wall's new geometry. */
  function commitEndpointMove(ep: { wall: WallRecord; end: 'a' | 'b' }) {
    const w = state.wallRecords.find(x => x.id === ep.wall.id)
    buildDrag = 'none'
    endpointDrag = null
    if (w) {
      api.updateWall(w.id, { ax: w.ax, ay: w.ay, bx: w.bx, by: w.by })
        .catch(() => showNotif('Wall update failed'))
      recomputeWalls()
    }
    render()
  }

  // ── Grid setup (M1.1) ───────────────────────────────────────────────────────

  /** Floating panel adjusting grid size + map offset live; Save persists. */
  function openGridSetup() {
    // One panel at a time
    root.querySelector('#grid-setup-panel')?.remove()
    const floor = state.floor
    if (!floor) return
    const panel = document.createElement('div')
    panel.id = 'grid-setup-panel'
    panel.style.cssText = 'position:absolute;top:64px;right:16px;z-index:50;background:var(--bg-card,#232622);border:1px solid var(--border,#3a3d36);border-radius:10px;padding:14px;width:230px;font-size:13px;color:var(--text,#e8e4d8);box-shadow:0 6px 24px rgba(0,0,0,.4)'
    const gs = state.table.grid_size ?? 70
    const ox = state.table.map_offset_x ?? 0
    const oy = state.table.map_offset_y ?? 0
    panel.innerHTML = `
      <div style="font-weight:600;margin-bottom:8px">▦ Grid setup</div>
      <label style="display:block;margin-bottom:6px">Square size (px)
        <input id="gs-size" type="number" min="10" max="500" value="${gs}" style="width:100%;margin-top:3px">
      </label>
      <div style="margin-bottom:6px">Offset X: <span id="gs-ox">${ox}</span> · Y: <span id="gs-oy">${oy}</span></div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px">
        <button data-nudge="left" style="flex:1">←</button>
        <button data-nudge="right" style="flex:1">→</button>
        <button data-nudge="up" style="flex:1">↑</button>
        <button data-nudge="down" style="flex:1">↓</button>
        <button data-nudge="reset" style="flex:1">⟲</button>
      </div>
      <label style="display:flex;gap:6px;align-items:center;margin-bottom:8px">
        <input id="gs-big" type="checkbox" checked> big steps (1 grid)
      </label>
      <button id="gs-save" style="width:100%;padding:6px">Save</button>
      <button id="gs-close" style="width:100%;padding:6px;margin-top:4px">Close</button>
    `
    wrap.appendChild(panel)
    const applyPreview = () => {
      const size = Math.max(10, Math.min(500, Number((panel.querySelector('#gs-size') as HTMLInputElement).value) || 70))
      state.table.grid_size = size
      render()
    }
    panel.querySelector('#gs-size')?.addEventListener('input', applyPreview)
    panel.querySelectorAll('[data-nudge]').forEach(btn => {
      btn.addEventListener('click', () => {
        const big = (panel.querySelector('#gs-big') as HTMLInputElement).checked
        const step = big ? (state.table.grid_size ?? 70) : 1
        const dir = (btn as HTMLElement).dataset.nudge
        if (dir === 'reset') { state.table.map_offset_x = 0; state.table.map_offset_y = 0 }
        if (dir === 'left') state.table.map_offset_x = (state.table.map_offset_x ?? 0) - step
        if (dir === 'right') state.table.map_offset_x = (state.table.map_offset_x ?? 0) + step
        if (dir === 'up') state.table.map_offset_y = (state.table.map_offset_y ?? 0) - step
        if (dir === 'down') state.table.map_offset_y = (state.table.map_offset_y ?? 0) + step
        const oxEl = panel.querySelector('#gs-ox') as HTMLElement
        const oyEl = panel.querySelector('#gs-oy') as HTMLElement
        oxEl.textContent = String(state.table.map_offset_x ?? 0)
        oyEl.textContent = String(state.table.map_offset_y ?? 0)
        render()
      })
    })
    panel.querySelector('#gs-save')?.addEventListener('click', () => {
      api.updateFloor(floor.id, {
        grid_size: state.table.grid_size ?? 70,
        map_offset_x: state.table.map_offset_x ?? 0,
        map_offset_y: state.table.map_offset_y ?? 0,
      })
        .then(() => showNotif('Grid saved'))
        .catch(() => showNotif('Save failed'))
    })
    panel.querySelector('#gs-close')?.addEventListener('click', () => panel.remove())
  }

  uiCanvas.addEventListener('mousedown', (e) => {
    const [wx, wy] = screenToWorld(e.offsetX, e.offsetY, state.camera)

    if (e.button === 1 || (e.button === 2)) {
      // Middle/right mouse = pan (right-click without dragging = reclassify)
      rightDownX = e.offsetX
      rightDownY = e.offsetY
      startPan(e.offsetX, e.offsetY)
      uiCanvas.style.cursor = 'grabbing'
      return
    }

    if (e.button === 0) {
      // Build mode owns the canvas. Tools: draw, erase, select/move walls.
      // Right/middle mouse still pans (handled above) so navigation is
      // always available while building.
      if (state.mode === 'build') {
        if (isAdmin) buildMouseDown(e.offsetX, e.offsetY, wx, wy, e.shiftKey)
        return
      }
      if (state.tool === 'stairs' && isAdmin) {
        placeStairs(wx, wy)
        return
      }
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
          socket.send('measure_update', { measure: { ...state.measure }, floor_id: state.floor?.id })
        }
        return
      }

      // Select tool: tokens win over doors/stairs — a token standing on a
      // door must stay grabbable. Doors are only toggled on empty clicks.
      const hit = pickToken(wx, wy, state.tokens, state.table.grid_size ?? 70)
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
        // No token under the cursor: portal click (threshold = 30% of a
        // grid cell) — open/close shortcut for every role, permission-checked
        const portalHit = pickPortal(wx, wy, state.portals, (state.table.grid_size ?? 70) * 0.3)
        if (portalHit) {
          if (mayTogglePortal(portalHit)) togglePortal(portalHit)
          else showNotif(`Only the DM can open this ${portalHit.kind}`)
          return
        }

        state.selectedId = null
        refreshSidebar()
        if (isAdmin) renderTokenEditor()
      }
      render()
    }
  })

  // ── Shared input logic (mouse + touch) ───────────────────────────────────────

  /** Move the dragged token toward a screen position, blocking at walls. */
  function dragInputTo(screenX: number, screenY: number) {
    if (!state.dragging || !state.selectedId) return
    const [wx, wy] = screenToWorld(screenX - state.dragOffX, screenY - state.dragOffY, state.camera)
    const snapX = state.snap ? snapToGrid(wx, state.table.grid_size ?? 70) : wx
    const snapY = state.snap ? snapToGrid(wy, state.table.grid_size ?? 70) : wy
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
        markExploredDirty()
      }
      // Throttle: broadcast live position at ~20 fps so other clients see the drag in real-time
      const now = Date.now()
      if (now - lastMoveBroadcast > 50) {
        socket.send('token_move', { token_id: token.id, x: token.x, y: token.y })
        lastMoveBroadcast = now
      }
    }
    render()
  }

  /** Commit the token drag: wall safety net + final broadcast. */
  function finishTokenDrag() {
    state.dragging = false
    markExploredDirty()   // exact (unquantized) polygon on the next stamp
    const token = state.tokens.find(t => t.id === state.selectedId)
    if (!token) return
    // The drag already blocks walls incrementally along the path actually
    // taken, so the legal way around a corner must NOT be rejected here —
    // a straight-line start→end check would falsely flag L-shaped moves.
    // Only the resting point is re-validated (race: a door closed under
    // the token mid-drag).
    const blocked = pointOnWall(token.x, token.y, state.walls)
    if (blocked) {
      // Revert locally and tell every other client to snap back too
      token.x = state.dragStartX
      token.y = state.dragStartY
      socket.send('token_move', { token_id: token.id, x: state.dragStartX, y: state.dragStartY })
      showNotif('Movement blocked by wall')
      markExploredDirty()
      render()
    } else {
      // Dropping the token on a stair marker sends it to the linked floor
      // and the mover's display follows it there
      const stair = pickStair(token.x, token.y, state.stairs, state.table.grid_size ?? 70)
      if (stair) {
        const target = state.floors.find(f => f.id === stair.to_floor)
        socket.send('token_move', {
          token_id: token.id, x: token.x, y: token.y,
          to_floor: stair.to_floor, to_x: stair.to_x, to_y: stair.to_y,
        })
        showNotif(`${token.name || 'Token'} → ${target ? floorLabel(target) : 'another floor'}`)
        switchFloor(stair.to_floor)
        return
      }
      socket.send('token_move', { token_id: token.id, x: token.x, y: token.y })
    }
  }

  /** End the active measurement; keep it on screen when shared. */
  function finishMeasure() {
    if (!state.measure.active) return
    state.measure.active = false
    // Keep a shared measurement visible after release — on the players'
    // screens (broadcast) and on the admin's own screen for consistency
    if (isAdmin && state.shareMeasure) {
      const persisted: MeasureState = { ...state.measure, active: false, persist: true }
      socket.send('measure_update', { measure: persisted, floor_id: state.floor?.id })
      state.sharedMeasure = persisted
    }
    render()
  }

  /** Begin panning from a screen position (right/middle mouse, touch). */
  function startPan(screenX: number, screenY: number) {
    state.panning = true
    state.panStartX = screenX
    state.panStartY = screenY
    state.panCamX = state.camera.x
    state.panCamY = state.camera.y
  }

  function panTo(screenX: number, screenY: number) {
    const dx = (screenX - state.panStartX) / state.camera.zoom
    const dy = (screenY - state.panStartY) / state.camera.zoom
    state.camera = { ...state.camera, x: state.panCamX - dx, y: state.panCamY - dy }
    render()
  }

  uiCanvas.addEventListener('mousemove', (e) => {
    if (state.panning) {
      panTo(e.offsetX, e.offsetY)
      return
    }

    // Build mode: wall ghost / marquee / wall drags
    if (state.mode === 'build' && isAdmin) {
      buildMouseMove(e.offsetX, e.offsetY)
      return
    }

    if (state.dragging && state.selectedId) {
      dragInputTo(e.offsetX, e.offsetY)
      return
    }

    if (state.measure.active) {
      const [wx, wy] = screenToWorld(e.offsetX, e.offsetY, state.camera)
      state.measure.endX = wx; state.measure.endY = wy
      const now = Date.now()
      if (isAdmin && state.shareMeasure && now - lastMeasureBroadcast > 50) {
        socket.send('measure_update', { measure: { ...state.measure }, floor_id: state.floor?.id })
        lastMeasureBroadcast = now
      }
      render()
      return
    }

    // Cursor hint for portal hover (admin only) — not where a token would be picked
    if (isAdmin && state.tool === 'select' && !state.dragging && !state.panning) {
      const [wx, wy] = screenToWorld(e.offsetX, e.offsetY, state.camera)
      const near = !pickToken(wx, wy, state.tokens, state.table.grid_size ?? 70)
        && pickPortal(wx, wy, state.portals, (state.table.grid_size ?? 70) * 0.3)
      uiCanvas.style.cursor = near ? 'pointer' : 'crosshair'
    }
  })

  uiCanvas.addEventListener('mouseup', async (e) => {
    if (state.panning) {
      state.panning = false
      uiCanvas.style.cursor = 'crosshair'
      return
    }

    // Build mode: commit wall draws / drags / marquee
    if (state.mode === 'build' && isAdmin && e.button === 0) {
      buildMouseUp(e.offsetX, e.offsetY)
      return
    }

    if (state.dragging && state.selectedId) {
      finishTokenDrag()
      return
    }

    if (state.measure.active && e.button === 0) {
      finishMeasure()
    }
  })

  // ── Context menu (right-click on doors, windows and stairs) ─────────────────
  interface CtxItem { label: string; action: () => void; danger?: boolean }

  const ctxMenu = document.createElement('div')
  ctxMenu.className = 'ctx-menu'
  ctxMenu.style.display = 'none'
  wrap.appendChild(ctxMenu)

  function hideCtxMenu() { ctxMenu.style.display = 'none' }

  function showCtxMenu(x: number, y: number, title: string, items: CtxItem[]) {
    ctxMenu.innerHTML = `<div style="padding:6px 12px 4px;font-family:var(--font-title);font-size:13px;font-weight:600;color:var(--muted)">${esc(title)}</div>`
      + items.map((it, i) => `<button data-ctx="${i}" class="${it.danger ? 'ctx-err' : ''}">${esc(it.label)}</button>`).join('')
    ctxMenu.querySelectorAll('[data-ctx]').forEach(btn => {
      btn.addEventListener('click', () => {
        hideCtxMenu()
        items[parseInt((btn as HTMLElement).dataset.ctx!)].action()
      })
    })
    ctxMenu.style.display = ''
    // Clamp inside the visible area
    const maxX = wrap.clientWidth - ctxMenu.offsetWidth - 4
    const maxY = wrap.clientHeight - ctxMenu.offsetHeight - 4
    ctxMenu.style.left = Math.max(4, Math.min(x, maxX)) + 'px'
    ctxMenu.style.top = Math.max(4, Math.min(y, maxY)) + 'px'
  }

  document.addEventListener('click', hideCtxMenu)
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtxMenu() })

  let rightDownX = 0, rightDownY = 0
  uiCanvas.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    const rect = uiCanvas.getBoundingClientRect()
    const x = e.clientX - rect.left, y = e.clientY - rect.top
    if (Math.hypot(x - rightDownX, y - rightDownY) > 6) return // it was a pan

    const [wx, wy] = screenToWorld(x, y, state.camera)

    // Doors and windows: open/close + convert (players: open/close only,
    // when the admin allows it for the kind)
    const portalHit = pickPortal(wx, wy, state.portals, (state.table.grid_size ?? 70) * 0.3)
    if (portalHit) {
      const kindLabel = portalHit.kind === 'window' ? 'window' : 'door'
      const items: CtxItem[] = []
      if (mayTogglePortal(portalHit)) {
        items.push({ label: portalHit.closed ? 'Open' : 'Close', action: () => togglePortal(portalHit) })
      }
      if (isAdmin) {
        items.push({ label: portalHit.kind === 'window' ? 'Convert to door' : 'Convert to window', action: () => reclassifyPortal(portalHit) })
        items.push({ label: portalHit.locked ? 'Unlock for players' : 'Lock for players', action: () => {
          api.setPortalLocked(state.table.id, portalHit.id, !portalHit.locked)
            .then(updated => {
              const idx = state.portals.findIndex(p => p.id === updated.id)
              if (idx !== -1) state.portals[idx] = updated
              render()
            })
            .catch(() => showNotif('Failed to update lock'))
        } })
      }
      if (items.length > 0) showCtxMenu(x, y, kindLabel, items)
      else showNotif(`Only admins can open this ${kindLabel}`)
      return
    }

    // Stairs (admin): change destination or delete — the only way to manage
    // them, left-click does nothing
    const stairHit = isAdmin ? pickStair(wx, wy, state.stairs, state.table.grid_size ?? 70) : null
    if (stairHit) {
      const target = state.floors.find(f => f.id === stairHit.to_floor)
      showCtxMenu(x, y, `Stairs → ${target ? floorLabel(target) : '?'}`, [
        { label: 'Change destination…', action: () => changeStairDestination(stairHit) },
        { label: 'Delete', action: () => deleteStair(stairHit), danger: true },
      ])
    }
  })

  // ── Touch / Apple Pencil support ─────────────────────────────────────────────
  // One finger or pencil: drag tokens (or use the active tool); a tap on a
  // token selects it, a tap on empty space deselects. Two fingers: pinch
  // zoom + pan. A single finger on empty space also pans the map.
  type TouchMode = 'none' | 'token' | 'pan' | 'measure' | 'pinch' | 'wait'
  let touchMode: TouchMode = 'none'
  let touchId: number | null = null
  let touchStartTime = 0
  let touchStartX = 0
  let touchStartY = 0
  let touchLastX = 0
  let touchLastY = 0
  let lastTouchDist = 0
  let lastPinchMidX = 0
  let lastPinchMidY = 0

  function touchPos(t: Touch): [number, number] {
    const rect = uiCanvas.getBoundingClientRect()
    return [t.clientX - rect.left, t.clientY - rect.top]
  }

  /** Abort a single-finger gesture when a second finger lands. */
  function cancelTouchGesture() {
    if (touchMode === 'token' && state.dragging) {
      // Snap the token back where the drag started
      const token = state.tokens.find(t => t.id === state.selectedId)
      if (token) {
        token.x = state.dragStartX
        token.y = state.dragStartY
        socket.send('token_move', { token_id: token.id, x: token.x, y: token.y })
      }
      state.dragging = false
      markExploredDirty()
    }
    if (state.measure.active) state.measure.active = false
    state.panning = false
    render()
  }

  uiCanvas.addEventListener('touchstart', (e) => {
    e.preventDefault()
    const list = Array.from(e.touches)

    if (list.length >= 2) {
      cancelTouchGesture()
      touchMode = 'pinch'
      lastTouchDist = Math.hypot(
        list[0].clientX - list[1].clientX,
        list[0].clientY - list[1].clientY,
      )
      lastPinchMidX = (list[0].clientX + list[1].clientX) / 2
      lastPinchMidY = (list[0].clientY + list[1].clientY) / 2
      return
    }

    if (list.length !== 1 || touchMode !== 'none') return
    const t = list[0]
    const [x, y] = touchPos(t)
    touchId = t.identifier
    touchStartTime = Date.now()
    touchStartX = touchLastX = x
    touchStartY = touchLastY = y
    const [wx, wy] = screenToWorld(x, y, state.camera)

    // Active tools first (same behaviour as a left click)
    if (state.tool === 'stairs' && isAdmin) { placeStairs(wx, wy); return }
    if (state.tool === 'fog-reveal' && isAdmin) { addFogPoint(wx, wy); return }
    if (state.tool === 'fog-erase' && isAdmin) { removeFogPoint(wx, wy); return }
    if (state.tool !== 'select') {
      state.measure = { active: true, tool: state.tool, startX: wx, startY: wy, endX: wx, endY: wy }
      if (isAdmin && state.shareMeasure) {
        socket.send('measure_update', { measure: { ...state.measure }, floor_id: state.floor?.id })
      }
      touchMode = 'measure'
      return
    }

    // Tokens win over doors/stairs — a token standing on a door must stay
    // grabbable (same priority as the mouse handler). Fingers get a wider
    // grab radius than a mouse cursor (~10 screen px, whatever the zoom).
    const grabSlop = 10 / state.camera.zoom
    const hit = pickToken(wx, wy, state.tokens, state.table.grid_size ?? 70, grabSlop)
    if (hit) {
      state.selectedId = hit.id
      const canMove = isAdmin || !state.settings.players_move_own_only || hit.owner === user.username
      if (canMove) {
        touchMode = 'token'
        const [tx, ty] = worldToScreen(hit.x, hit.y, state.camera)
        state.dragging = true
        state.dragOffX = x - tx
        state.dragOffY = y - ty
        state.dragStartX = hit.x
        state.dragStartY = hit.y
      } else {
        touchMode = 'pan' // selection only — finger pans the map
        startPan(x, y)
      }
      refreshSidebar()
      if (isAdmin) renderTokenEditor()
      render()
      return
    }

    // Portal tap toggles the door/window — every role, permission-checked
    // (stairs are managed through the context menu only)
    {
      const portalHit = pickPortal(wx, wy, state.portals, (state.table.grid_size ?? 70) * 0.3)
      if (portalHit) {
        if (mayTogglePortal(portalHit)) togglePortal(portalHit)
        else showNotif(`Only the DM can open this ${portalHit.kind}`)
        return
      }
    }

    // Empty space: one finger pans
    touchMode = 'pan'
    startPan(x, y)
  }, { passive: false })

  uiCanvas.addEventListener('touchmove', (e) => {
    e.preventDefault()
    const list = Array.from(e.touches)

    if (touchMode === 'pinch') {
      if (list.length >= 2) {
        const rect = uiCanvas.getBoundingClientRect()
        const cx = (list[0].clientX + list[1].clientX) / 2 - rect.left
        const cy = (list[0].clientY + list[1].clientY) / 2 - rect.top
        const midScreenX = (list[0].clientX + list[1].clientX) / 2
        const midScreenY = (list[0].clientY + list[1].clientY) / 2
        const d = Math.hypot(
          list[0].clientX - list[1].clientX,
          list[0].clientY - list[1].clientY,
        )
        if (lastTouchDist > 0) {
          const delta = d > lastTouchDist ? 1 : -1
          state.camera = zoomAround(state.camera, cx, cy, delta)
          // Two-finger pan: follow the midpoint movement
          const dx = (midScreenX - lastPinchMidX) / state.camera.zoom
          const dy = (midScreenY - lastPinchMidY) / state.camera.zoom
          state.camera = { ...state.camera, x: state.camera.x - dx, y: state.camera.y - dy }
        }
        lastTouchDist = d
        lastPinchMidX = midScreenX
        lastPinchMidY = midScreenY
        render()
      }
      return
    }

    if (touchMode === 'wait') return

    const t = list.find(t => t.identifier === touchId)
    if (!t) return
    const [x, y] = touchPos(t)
    touchLastX = x
    touchLastY = y

    if (touchMode === 'token') {
      dragInputTo(x, y)
      return
    }
    if (touchMode === 'pan' && state.panning) {
      panTo(x, y)
      return
    }
    if (touchMode === 'measure' && state.measure.active) {
      const [wx, wy] = screenToWorld(x, y, state.camera)
      state.measure.endX = wx; state.measure.endY = wy
      const now = Date.now()
      if (isAdmin && state.shareMeasure && now - lastMeasureBroadcast > 50) {
        socket.send('measure_update', { measure: { ...state.measure }, floor_id: state.floor?.id })
        lastMeasureBroadcast = now
      }
      render()
    }
  }, { passive: false })

  uiCanvas.addEventListener('touchend', (e) => {
    const remaining = Array.from(e.touches)

    if (touchMode === 'pinch') {
      // Require all fingers up before starting a new gesture (avoids jumps)
      if (remaining.length === 0) touchMode = 'none'
      else if (remaining.length === 1) touchMode = 'wait'
      return
    }
    if (touchMode === 'wait') {
      if (remaining.length === 0) touchMode = 'none'
      return
    }
    if (remaining.length > 0 || touchMode === 'none') return

    if (touchMode === 'token') finishTokenDrag()
    if (touchMode === 'measure') finishMeasure()

    const dt = Date.now() - touchStartTime
    const moved = Math.hypot(touchLastX - touchStartX, touchLastY - touchStartY)
    if (touchMode === 'pan' && dt < 300 && moved < 10) {
      // Tap on empty space: deselect
      const [wx, wy] = screenToWorld(touchStartX, touchStartY, state.camera)
      if (!pickToken(wx, wy, state.tokens, state.table.grid_size ?? 70, 10 / state.camera.zoom)) {
        state.selectedId = null
        refreshSidebar()
        if (isAdmin) renderTokenEditor()
        render()
      }
    }

    state.panning = false
    touchMode = 'none'
    touchId = null
  })

  /** Build-mode keyboard shortcuts; returns true when the key was consumed. */
  function buildModeKeys(key: string, e: KeyboardEvent): boolean {
    const buildMap: Record<string, ToolType> = { w: 'wall-select', d: 'wall', x: 'wall-erase', o: 'door', j: 'window', g: 'grid-setup' }
    const bt = buildMap[key]
    if (bt) {
      state.tool = bt
      renderToolbar()
      return true
    }
    if (e.key === 'Escape') {
      state.selectedId = null
      render()
    }
    return true // build mode consumes everything else below this line
  }

  /** Play-mode tool shortcuts (S/L/C/Q/N); returns true when consumed. */
  function playModeToolKeys(key: string): boolean {
    const map: Record<string, ToolType> = { s: 'select', l: 'line', c: 'circle', q: 'square', n: 'cone' }
    const tool = map[key]
    if (!tool) return false
    state.tool = tool
    root.querySelectorAll('[data-tool]').forEach(b => {
      b.classList.toggle('active', (b as HTMLElement).dataset.tool === state.tool)
    })
    return true
  }

  // Keyboard shortcuts
  const onKeydown = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
    const key = e.key.toLowerCase()
    if (key === 'b' && isAdmin) {
      setMode(state.mode === 'build' ? 'play' : 'build')
      return
    }
    if (state.mode === 'build') {
      buildModeKeys(key, e)
      return
    }
    playModeToolKeys(key)
    if (e.key === 'Escape') handleEscapeKey()
    if (e.key === 'Delete' && state.selectedId && isAdmin) handleDeleteKey()
  }

  /** Escape: exit zen, deselect, cancel measuring (shared broadcast). */
  function handleEscapeKey(): void {
    if (state.zen) exitZen()
    state.selectedId = null
    state.measure.active = false
    if (state.shareMeasure) socket.send('measure_update', { measure: null, floor_id: state.floor?.id })
    refreshSidebar(); renderTokenEditor(); render()
  }

  /** Delete: remove the selected token (admin, with confirm). */
  function handleDeleteKey(): void {
    const token = state.tokens.find(t => t.id === state.selectedId)
    if (token && confirm(`Delete ${token.name}?`)) {
      api.deleteToken(state.table.id, token.id)
      socket.send('token_delete', { token_id: token.id })
      state.tokens = state.tokens.filter(t => t.id !== token.id)
      state.selectedId = null
      markExploredDirty()
      refreshSidebar(); renderTokenEditor(); render()
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
    // Release the decoded tile bitmaps and the fog overview
    resetTileCache()
    state.fogOverview?.close()
    state.fogOverview = null
    resetVisionCache()
    disposeLosWorker()
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

  // Stairs placement (admin): link the clicked point to a chosen floor
  async function placeStairs(wx: number, wy: number) {
    const others = state.floors.filter(f => f.id !== state.floor?.id)
    if (others.length === 0) { showNotif('Only one floor — add floors to this table first'); return }
    const labels = others.map(f => floorLabel(f)).join(', ')
    const answer = prompt(`Link these stairs to which floor? (${labels})`, others.length === 1 ? floorLabel(others[0]) : '')
    if (!answer) return
    const q = answer.trim().toLowerCase()
    const target = others.find(f =>
      floorLabel(f).toLowerCase() === q || String(f.level) === q || f.name.toLowerCase() === q)
    if (!target) { showNotif('Unknown floor'); return }
    try {
      const st = await api.createStair(state.table.id, {
        from_floor: state.floor!.id, from_x: wx, from_y: wy,
        to_floor: target.id, to_x: wx, to_y: wy, radius: 1,
      })
      state.stairs.push(st)
      showNotif(`Stairs to ${floorLabel(target)} placed`)
      render()
    } catch (e: any) { showNotif('Failed: ' + e.message) }
  }

  /** May this user toggle this portal? Admins always; players when the
   *  admin enabled it for the portal's kind. */
  function mayTogglePortal(portal: Portal): boolean {
    if (isAdmin) return true
    if (portal.locked) return false
    return portal.kind === 'window'
      ? state.settings.players_open_windows
      : state.settings.players_open_doors
  }

  function togglePortal(portal: Portal) {
    api.togglePortal(state.table.id, portal.id, !portal.closed)
      .then(updated => {
        const idx = state.portals.findIndex(p => p.id === updated.id)
        if (idx !== -1) state.portals[idx] = updated
        recomputeWalls()
        render()
      })
      .catch(() => showNotif('You cannot open this ' + (portal.kind ?? 'door')))
  }

  /** Admin: reclassify a portal door ↔ window. */
  function reclassifyPortal(portal: Portal) {
    const newKind = portal.kind === 'window' ? 'door' : 'window'
    api.setPortalKind(state.table.id, portal.id, newKind)
      .then(updated => {
        const idx = state.portals.findIndex(p => p.id === updated.id)
        if (idx !== -1) state.portals[idx] = updated
        recomputeWalls()
        render()
      })
      .catch(() => showNotif('Failed to reclassify'))
  }

  /** Admin: delete a stairs marker. */
  function deleteStair(stair: Stairs) {
    api.deleteStair(stair.id)
      .then(() => { state.stairs = state.stairs.filter(st => st.id !== stair.id); render() })
      .catch(() => showNotif('Failed to delete stairs'))
  }

  /** Admin: point a stairs marker at another floor. */
  function changeStairDestination(stair: Stairs) {
    const others = state.floors.filter(f => f.id !== stair.from_floor)
    if (others.length === 0) { showNotif('No other floor to link to'); return }
    const labels = others.map(f => floorLabel(f)).join(', ')
    const answer = prompt(`Link these stairs to which floor? (${labels})`,
      others.length === 1 ? floorLabel(others[0]) : floorLabel(others[0]))
    if (!answer) return
    const q = answer.trim().toLowerCase()
    const target = others.find(f =>
      floorLabel(f).toLowerCase() === q || String(f.level) === q || f.name.toLowerCase() === q)
    if (!target) { showNotif('Unknown floor'); return }
    api.updateStair(state.table.id, stair.id, { to_floor: target.id })
      .then(updated => {
        const idx = state.stairs.findIndex(st => st.id === updated.id)
        if (idx !== -1) state.stairs[idx] = updated
        showNotif(`Stairs now lead to ${floorLabel(target)}`)
        render()
      })
      .catch((e: any) => showNotif('Failed: ' + e.message))
  }

  // Fog helpers
  function addFogPoint(wx: number, wy: number) {
    const point: FogPoint = { id: '', table_id: table.id, x: wx, y: wy, radius: 3, floor_id: state.floor?.id }
    socket.send('fog_update', { action: 'add', points: [point], floor_id: state.floor?.id })
    state.fog.push(point)
    markExploredDirty()
    render()
  }

  function removeFogPoint(wx: number, wy: number) {
    state.fog = state.fog.filter(p => Math.hypot(p.x - wx, p.y - wy) > p.radius * (state.table.grid_size ?? 70))
    // One atomic clear+re-add so other clients never see an empty flash
    socket.send('fog_update', { action: 'clear_all', points: state.fog, floor_id: state.floor?.id })
    markExploredDirty()
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

/** Nearest stair marker whose pickup radius contains the point. */
function pickStair(wx: number, wy: number, stairs: Stairs[], gridSize: number): Stairs | null {
  for (const st of stairs) {
    if (Math.hypot(wx - st.from_x, wy - st.from_y) <= Math.max(st.radius, 0.6) * gridSize) return st
  }
  return null
}

function pickToken(wx: number, wy: number, tokens: Token[], gridSize: number, slop = 0): Token | null {
  // iterate in reverse (top token first). `slop` widens the hit radius for
  // touch input — fingers are far less precise than a mouse cursor.
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]
    const r = (gridSize * t.size) / 2 + slop
    if (Math.hypot(wx - t.x, wy - t.y) <= r) return t
  }
  return null
}

function randomColor() {
  // Muted naturals that read well on parchment maps
  const colors = ['#4D5947', '#8A5E61', '#9A7656', '#76604E', '#5C7188', '#8C8A5E', '#6E5E7B']
  return colors[Math.floor(Math.random() * colors.length)]
}

function esc(s: string) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

