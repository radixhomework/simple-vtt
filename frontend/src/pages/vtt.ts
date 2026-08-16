import { api } from '../api/client'
import type { User, Table } from '../types'

export function renderVtt(
  root: HTMLElement,
  user: User,
  onJoin: (table: Table) => void,
  onLogout: () => void,
) {
  const isAdmin = user.role === 'admin'

  const render = async () => {
    const tables = await api.listTables()
    root.innerHTML = `
      <style>
        .lobby { display: flex; flex-direction: column; height: 100%; background: #0f0f1a; color: #e0e0f0; }
        .lobby-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 16px 24px; background: #1a1a2e; border-bottom: 1px solid #2d2d4e;
        }
        .lobby-title { font-size: 20px; font-weight: 700; display: flex; align-items: center; gap: 10px; }
        .lobby-user { display: flex; align-items: center; gap: 12px; font-size: 14px; color: #9090b0; }
        .badge { padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
        .badge-admin { background: #7c3aed; color: #e9d5ff; }
        .badge-player { background: #1e40af; color: #bfdbfe; }
        .lobby-body { flex: 1; overflow-y: auto; padding: 32px; max-width: 900px; margin: 0 auto; width: 100%; }
        .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
        .section-title { font-size: 16px; font-weight: 600; color: #c0c0e0; }
        .tables-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; margin-bottom: 32px; }
        .table-card {
          background: #1a1a2e; border: 1px solid #2d2d4e; border-radius: 10px;
          padding: 20px; cursor: pointer; transition: border-color 0.2s, transform 0.1s;
          display: flex; flex-direction: column; gap: 8px;
        }
        .table-card:hover { border-color: #4a90d9; transform: translateY(-2px); }
        .table-card-name { font-size: 16px; font-weight: 600; }
        .table-card-meta { font-size: 12px; color: #6060a0; }
        .table-card-actions { display: flex; gap: 8px; margin-top: 8px; }
        .btn { padding: 7px 14px; border-radius: 7px; border: none; cursor: pointer; font-size: 13px; font-weight: 500; transition: opacity 0.15s; }
        .btn:hover { opacity: 0.85; }
        .btn-primary { background: #4a90d9; color: #fff; }
        .btn-danger { background: #dc2626; color: #fff; }
        .btn-ghost { background: transparent; color: #9090b0; border: 1px solid #2d2d4e; }
        .btn-sm { padding: 5px 10px; font-size: 12px; }
        .admin-section { background: #1a1a2e; border: 1px solid #2d2d4e; border-radius: 10px; padding: 24px; margin-bottom: 24px; }
        .admin-section h3 { font-size: 14px; font-weight: 600; color: #9090b0; margin-bottom: 16px; text-transform: uppercase; letter-spacing: 0.05em; }
        .form-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
        .form-field { display: flex; flex-direction: column; gap: 5px; }
        .form-field label { font-size: 12px; color: #6060a0; }
        .form-field input, .form-field select {
          padding: 8px 12px; background: #0f0f1a; border: 1px solid #2d2d4e;
          border-radius: 7px; color: #e0e0f0; font-size: 13px; outline: none;
          transition: border-color 0.2s;
        }
        .form-field input:focus, .form-field select:focus { border-color: #4a90d9; }
        .users-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
        .user-chip {
          display: flex; align-items: center; gap: 6px; padding: 4px 10px;
          background: #0f0f1a; border: 1px solid #2d2d4e; border-radius: 20px; font-size: 13px;
        }
        .user-chip button { background: none; border: none; cursor: pointer; color: #f87171; font-size: 14px; line-height: 1; padding: 0 2px; }
        .upload-zone {
          border: 2px dashed #2d2d4e; border-radius: 8px; padding: 20px;
          text-align: center; cursor: pointer; transition: border-color 0.2s; color: #6060a0; font-size: 13px;
        }
        .upload-zone:hover, .upload-zone.drag { border-color: #4a90d9; color: #9090b0; }
        .msg { font-size: 13px; margin-top: 8px; min-height: 16px; }
        .msg-ok { color: #34d399; }
        .msg-err { color: #f87171; }
        .empty-state { text-align: center; padding: 48px; color: #4040a0; }
      </style>
      <div class="lobby">
        <div class="lobby-header">
          <div class="lobby-title">
            <svg width="28" height="28" viewBox="0 0 64 64" fill="none">
              <rect width="64" height="64" rx="8" fill="#1a1a2e"/>
              <polygon points="32,8 56,48 8,48" stroke="#4a90d9" stroke-width="3" fill="none"/>
              <circle cx="32" cy="32" r="6" fill="#4a90d9"/>
            </svg>
            RHW Simple VTT
          </div>
          <div class="lobby-user">
            <span>${user.username}</span>
            <span class="badge badge-${user.role}">${user.role}</span>
            <button class="btn btn-ghost btn-sm" id="logout-btn">Sign out</button>
          </div>
        </div>
        <div class="lobby-body">
          ${isAdmin ? adminHTML() : ''}

          <div class="section-header">
            <span class="section-title">Tables</span>
          </div>
          <div class="tables-grid" id="tables-grid">
            ${tables.length === 0
              ? `<div class="empty-state" style="grid-column:1/-1">No tables yet${isAdmin ? ' — create or import one above' : ''}.</div>`
              : tables.map(t => tableCardHTML(t, isAdmin)).join('')
            }
          </div>
        </div>
      </div>
    `

    root.querySelector('#logout-btn')!.addEventListener('click', onLogout)

    // Join table
    root.querySelectorAll('[data-join]').forEach(el => {
      el.addEventListener('click', () => {
        const id = (el as HTMLElement).dataset.join!
        const table = tables.find(t => t.id === id)
        if (table) onJoin(table)
      })
    })

    if (isAdmin) bindAdminHandlers(root, render)
  }

  render()
}

function tableCardHTML(t: import('../types').Table, isAdmin: boolean) {
  return `
    <div class="table-card">
      <div class="table-card-name">${esc(t.name)}</div>
      <div class="table-card-meta">Grid: ${t.grid_size}px/sq</div>
      <div class="table-card-actions">
        <button class="btn btn-primary btn-sm" data-join="${t.id}">Join</button>
        ${isAdmin ? `<button class="btn btn-danger btn-sm" data-del="${t.id}">Delete</button>` : ''}
      </div>
    </div>
  `
}

function adminHTML() {
  return `
    <div class="admin-section">
      <h3>Create Table</h3>
      <div class="form-row">
        <div class="form-field">
          <label>Name</label>
          <input id="new-table-name" placeholder="My Campaign" />
        </div>
        <div class="form-field">
          <label>Grid (px/sq)</label>
          <input id="new-table-grid" type="number" value="70" style="width:80px" />
        </div>
        <button class="btn btn-primary" id="create-table-btn">Create</button>
      </div>
      <div class="msg" id="create-table-msg"></div>
    </div>

    <div class="admin-section">
      <h3>Import Universal VTT (.uvtt / .zip)</h3>
      <div class="upload-zone" id="uvtt-drop">
        Drop a .uvtt or .zip file here, or click to browse
        <input type="file" id="uvtt-file" accept=".uvtt,.zip,.dd2vtt" style="display:none" />
      </div>
      <div class="msg" id="import-msg"></div>
    </div>

    <div class="admin-section">
      <h3>Manage Players</h3>
      <div class="form-row">
        <div class="form-field">
          <label>Username</label>
          <input id="new-user-name" placeholder="player1" />
        </div>
        <div class="form-field">
          <label>Password</label>
          <input id="new-user-pass" type="password" placeholder="••••••" />
        </div>
        <div class="form-field">
          <label>Role</label>
          <select id="new-user-role">
            <option value="player">Player</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <button class="btn btn-primary" id="create-user-btn">Add User</button>
      </div>
      <div class="users-list" id="users-list"></div>
      <div class="msg" id="user-msg"></div>
    </div>
  `
}

function bindAdminHandlers(root: HTMLElement, refresh: () => void) {
  // Delete table
  root.querySelectorAll('[data-del]').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation()
      const id = (el as HTMLElement).dataset.del!
      if (confirm('Delete this table and all its data?')) {
        await api.deleteTable(id)
        refresh()
      }
    })
  })

  // Create table
  root.querySelector('#create-table-btn')?.addEventListener('click', async () => {
    const name = (root.querySelector('#new-table-name') as HTMLInputElement).value.trim()
    const gridSize = parseInt((root.querySelector('#new-table-grid') as HTMLInputElement).value) || 70
    const msg = root.querySelector('#create-table-msg') as HTMLElement
    if (!name) { msg.textContent = 'Enter a table name'; msg.className = 'msg msg-err'; return }
    try {
      await api.createTable(name, gridSize)
      msg.textContent = 'Table created!'; msg.className = 'msg msg-ok'
      setTimeout(refresh, 800)
    } catch (e: any) {
      msg.textContent = e.message; msg.className = 'msg msg-err'
    }
  })

  // UVTT import drag & drop
  const dropZone = root.querySelector('#uvtt-drop') as HTMLElement
  const fileInput = root.querySelector('#uvtt-file') as HTMLInputElement
  const importMsg = root.querySelector('#import-msg') as HTMLElement

  dropZone.addEventListener('click', () => fileInput.click())
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag') })
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'))
  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault()
    dropZone.classList.remove('drag')
    const file = e.dataTransfer?.files[0]
    if (file) await doImport(file, importMsg, refresh)
  })
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0]
    if (file) await doImport(file, importMsg, refresh)
  })

  // Create user
  root.querySelector('#create-user-btn')?.addEventListener('click', async () => {
    const name = (root.querySelector('#new-user-name') as HTMLInputElement).value.trim()
    const pass = (root.querySelector('#new-user-pass') as HTMLInputElement).value
    const role = (root.querySelector('#new-user-role') as HTMLSelectElement).value
    const msg = root.querySelector('#user-msg') as HTMLElement
    if (!name || !pass) { msg.textContent = 'Fill in username and password'; msg.className = 'msg msg-err'; return }
    try {
      await api.createUser(name, pass, role)
      msg.textContent = 'User created!'; msg.className = 'msg msg-ok'
      loadUsers(root)
    } catch (e: any) {
      msg.textContent = e.message; msg.className = 'msg msg-err'
    }
  })

  loadUsers(root)
}

async function loadUsers(root: HTMLElement) {
  const list = root.querySelector('#users-list') as HTMLElement
  if (!list) return
  try {
    const users = await api.listUsers()
    list.innerHTML = users.map(u => `
      <div class="user-chip">
        <span class="badge badge-${u.role}">${u.role[0].toUpperCase()}</span>
        ${esc(u.username)}
        <button data-del-user="${esc(u.username)}" title="Delete user">×</button>
      </div>
    `).join('')
    list.querySelectorAll('[data-del-user]').forEach(el => {
      el.addEventListener('click', async () => {
        const username = (el as HTMLElement).dataset.delUser!
        if (confirm(`Delete user "${username}"?`)) {
          await api.deleteUser(username)
          loadUsers(root)
        }
      })
    })
  } catch {}
}

async function doImport(file: File, msg: HTMLElement, refresh: () => void) {
  msg.textContent = 'Importing…'; msg.className = 'msg'
  try {
    await api.importUVTT(file)
    msg.textContent = 'Import successful!'; msg.className = 'msg msg-ok'
    setTimeout(refresh, 800)
  } catch (e: any) {
    msg.textContent = 'Import failed: ' + e.message; msg.className = 'msg msg-err'
  }
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
