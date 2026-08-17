/**
 * Application entry: tiny history-based router (no framework). Pages are
 * rendered into #app by render* functions; only one page is mounted at a
 * time and each registers a teardown callback so navigation (including
 * back/forward) releases its sockets and listeners.
 */
import { api } from './api/client'
import { renderLogin } from './pages/login'
import { renderVtt } from './pages/vtt'
import { renderMap } from './pages/map'
import type { User, Table } from './types'

interface AppState {
  user: User | null
  table: Table | null
}

const state: AppState = { user: null, table: null }

// Teardown callback of the currently mounted page, used to release
// sockets/listeners when navigating away (including browser back/forward).
let teardownPage: (() => void) | null = null

function unmountCurrentPage() {
  if (teardownPage) {
    teardownPage()
    teardownPage = null
  }
}

async function bootstrap() {
  const root = document.getElementById('app')!
  const token = localStorage.getItem('token')

  if (token) {
    try {
      state.user = await api.me()
    } catch {
      localStorage.removeItem('token')
    }
  }

  // Handle browser back/forward
  window.addEventListener('popstate', () => route(root))

  route(root)
}

function currentPath() {
  return location.pathname
}

function push(path: string) {
  if (currentPath() !== path) history.pushState(null, '', path)
}

function route(root: HTMLElement) {
  const path = currentPath()

  // Not logged in → always go to /login
  if (!state.user) {
    unmountCurrentPage()
    push('/login')
    renderLogin(root, (user) => {
      state.user = user
      push('/vtt')
      route(root)
    })
    return
  }

  // Logged in: resolve destination
  if (path === '/' || path === '/login') {
    push('/vtt')
    route(root)
    return
  }

  if (path.startsWith('/map/')) {
    const tableId = path.split('/')[2]
    if (tableId && state.table?.id === tableId) {
      unmountCurrentPage()
      renderMap(root, state.user, state.table, (teardown) => {
        teardownPage = teardown
      }, () => {
        state.table = null
        push('/vtt')
        route(root)
      })
      return
    }
    // Table id in URL but not loaded — try to fetch it
    api.getTable(tableId).then(table => {
      state.table = table
      route(root)
    }).catch(() => {
      push('/vtt')
      route(root)
    })
    return
  }

  // Default: vtt
  push('/vtt')
  unmountCurrentPage()
  renderVtt(root, state.user, (table) => {
    state.table = table
    push(`/map/${table.id}`)
    route(root)
  }, () => {
    state.user = null
    state.table = null
    localStorage.removeItem('token')
    push('/login')
    route(root)
  })
}

bootstrap()
