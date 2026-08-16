import { api } from './api/client'
import { renderLogin } from './pages/login'
import { renderLobby } from './pages/lobby'
import { renderGame } from './pages/game'
import type { User, Table } from './types'

interface AppState {
  user: User | null
  table: Table | null
}

const state: AppState = { user: null, table: null }

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
    push('/login')
    renderLogin(root, (user) => {
      state.user = user
      push('/lobby')
      route(root)
    })
    return
  }

  // Logged in: resolve destination
  if (path === '/' || path === '/login') {
    push('/lobby')
    route(root)
    return
  }

  if (path.startsWith('/game/')) {
    const tableId = path.split('/')[2]
    if (tableId && state.table?.id === tableId) {
      renderGame(root, state.user, state.table, () => {
        state.table = null
        push('/lobby')
        route(root)
      })
      return
    }
    // Table id in URL but not loaded — try to fetch it
    api.getTable(tableId).then(table => {
      state.table = table
      route(root)
    }).catch(() => {
      push('/lobby')
      route(root)
    })
    return
  }

  // Default: lobby
  push('/lobby')
  renderLobby(root, state.user, (table) => {
    state.table = table
    push(`/game/${table.id}`)
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
