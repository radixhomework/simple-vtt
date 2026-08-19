/**
 * VTT home page. Players see the table list; admins get a multi-page
 * management console (Maps & Tables, Users, Assets) rendered above it.
 * Every user can change their own password from here.
 */
import { api } from '../api/client'
import type { User, Table, Asset, Floor } from '../types'

type AdminPage = 'tables' | 'users' | 'assets'

export function renderVtt(
  root: HTMLElement,
  user: User,
  onJoin: (table: Table) => void,
  onLogout: () => void,
) {
  const isAdmin = user.role === 'admin'
  let adminPage: AdminPage = 'tables'

  const render = async () => {
    const tables = await api.listTables()
    root.innerHTML = `
      <style>
        .lobby { display: flex; flex-direction: column; height: 100%; background: var(--bg); color: var(--text); }
        .lobby-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 16px 24px; background: var(--surface); border-bottom: 1px solid var(--border);
        }
        .lobby-title { font-family: var(--font-title); font-size: 23px; font-weight: 700; display: flex; align-items: center; gap: 10px; }
        .lobby-user { display: flex; align-items: center; gap: 12px; font-size: 14px; color: var(--muted); }
        .badge { padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
        .badge-admin { background: var(--brand); color: var(--on-brand); }
        .badge-player { background: var(--accent); color: var(--on-brand); }
        /* lobby-body is the full-width scroll container, so the scrollbar
           sits against the window's right border; the content column is
           centered inside it. */
        .lobby-body { flex: 1; overflow-y: auto; }
        .lobby-content { max-width: 1000px; margin: 0 auto; width: 100%; padding: 32px; }
        .section-header { display: flex; align-items: center; justify-content: space-between; margin: 24px 0 16px; }
        .section-title { font-family: var(--font-title); font-size: 18px; font-weight: 600; color: var(--text); }
        .tables-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; margin-bottom: 32px; }
        .table-card {
          background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
          padding: 20px; cursor: pointer; transition: border-color 0.2s, transform 0.1s;
          display: flex; flex-direction: column; gap: 8px;
        }
        .table-card:hover { border-color: var(--accent); transform: translateY(-2px); }
        .table-card-name { font-family: var(--font-title); font-size: 17px; font-weight: 600; }
        .table-card-meta { font-size: 12px; color: var(--muted); }
        .table-card-actions { display: flex; gap: 8px; margin-top: 8px; }
        .btn { padding: 7px 14px; border-radius: 7px; border: none; cursor: pointer; font-size: 13px; font-weight: 500; transition: opacity 0.15s; }
        .btn:hover { opacity: 0.85; }
        .btn-primary { background: var(--brand); color: var(--on-brand); }
        .btn-danger { background: var(--danger); color: var(--on-brand); }
        .btn-ghost { background: transparent; color: var(--muted); border: 1px solid var(--border); }
        .btn-sm { padding: 5px 10px; font-size: 12px; }
        .admin-nav { display: flex; gap: 6px; border-bottom: 1px solid var(--border); margin-bottom: 24px; flex-wrap: wrap; }
        .admin-tab {
          padding: 10px 18px; background: transparent; border: none; border-bottom: 2px solid transparent;
          color: var(--muted); font-size: 14px; font-weight: 600; cursor: pointer;
        }
        .admin-tab:hover { color: var(--text); }
        .admin-tab.active { color: var(--brand); border-bottom-color: var(--brand); }
        .admin-section { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 24px; margin-bottom: 24px; }
        .admin-section h3 { font-family: var(--font-title); font-size: 15px; font-weight: 600; color: var(--muted); margin-bottom: 16px; text-transform: uppercase; letter-spacing: 0.05em; }
        .data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .data-table th {
          text-align: left; padding: 8px 10px; color: var(--muted); font-size: 11px;
          text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid var(--border);
        }
        .data-table td { padding: 9px 10px; border-bottom: 1px solid var(--border); }
        .data-table tr:last-child td { border-bottom: none; }
        .data-table select, .data-table input[type=text] {
          padding: 5px 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
          color: var(--text); font-size: 12px; outline: none;
        }
        .row-actions { text-align: right; white-space: nowrap; }
        .row-actions .btn { margin-left: 6px; }
        .folder-head td { cursor: pointer; user-select: none; }
        .folder-head:hover td { color: var(--text); }
        .fold-arrow { display: inline-block; width: 14px; }
        .form-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
        .form-field { display: flex; flex-direction: column; gap: 5px; }
        .form-field label { font-size: 12px; color: var(--muted); }
        .form-field input, .form-field select {
          padding: 8px 12px; background: var(--bg); border: 1px solid var(--border);
          border-radius: 7px; color: var(--text); font-size: 13px; outline: none;
          transition: border-color 0.2s;
        }
        .form-field input:focus, .form-field select:focus { border-color: var(--accent); }
        .users-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
        .user-chip {
          display: flex; align-items: center; gap: 6px; padding: 4px 10px;
          background: var(--bg); border: 1px solid var(--border); border-radius: 20px; font-size: 13px;
        }
        .upload-zone {
          border: 2px dashed var(--border); border-radius: 8px; padding: 20px;
          text-align: center; cursor: pointer; transition: border-color 0.2s; color: var(--muted); font-size: 13px;
        }
        .upload-zone:hover, .upload-zone.drag { border-color: var(--accent); color: var(--text); }
        .msg { font-size: 13px; margin-top: 8px; min-height: 16px; }
        .msg-ok { color: var(--brand); }
        .msg-err { color: var(--danger); }
        .empty-state { text-align: center; padding: 48px; color: var(--faint); }
        .you { font-size: 11px; color: var(--muted); }
      </style>
      <div class="lobby">
        <div class="lobby-header">
          <div class="lobby-title">
            <svg width="28" height="28" viewBox="0 0 64 64" fill="none">
              <rect width="64" height="64" rx="8" fill="#1E211C"/>
              <polygon points="32,8 56,48 8,48" stroke="#9A7656" stroke-width="3" fill="none"/>
              <circle cx="32" cy="32" r="6" fill="#9A7656"/>
            </svg>
            RHW Simple VTT
          </div>
          <div class="lobby-user">
            <span>${esc(user.username)}</span>
            <span class="badge badge-${user.role}">${user.role}</span>
            <button class="btn btn-ghost btn-sm" id="pass-btn" title="Change password">🔑</button>
            <button class="btn btn-ghost btn-sm" id="logout-btn">Sign out</button>
          </div>
        </div>
        <div class="lobby-body">
          <div class="lobby-content">
          <div class="admin-section" id="pass-section" style="display:none">
            <h3>Change Password (${esc(user.username)})</h3>
            <div class="form-row">
              <div class="form-field">
                <label>Current password</label>
                <input id="pass-current" type="password" autocomplete="current-password" />
              </div>
              <div class="form-field">
                <label>New password</label>
                <input id="pass-new" type="password" autocomplete="new-password" />
              </div>
              <div class="form-field">
                <label>Confirm new password</label>
                <input id="pass-confirm" type="password" autocomplete="new-password" />
              </div>
              <button class="btn btn-primary" id="pass-save-btn">Save</button>
            </div>
            <div class="msg" id="pass-msg"></div>
          </div>

          ${isAdmin ? `
          <div class="admin-nav" id="admin-nav">
            <button class="admin-tab active" data-page="tables">🗺 Maps &amp; Tables</button>
            <button class="admin-tab" data-page="users">👥 Users</button>
            <button class="admin-tab" data-page="assets">📦 Assets</button>
            <span id="version-info" style="margin-left:auto;align-self:center;font-size:11px;color:var(--muted)"></span>
          </div>
          <div id="admin-page"></div>` : ''}

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
      </div>
    `

    root.querySelector('#logout-btn')!.addEventListener('click', onLogout)

    // Change password (admin and players)
    const passSection = root.querySelector('#pass-section') as HTMLElement | null
    root.querySelector('#pass-btn')?.addEventListener('click', () => {
      if (!passSection) return
      passSection.style.display = passSection.style.display === 'none' ? '' : 'none'
    })
    root.querySelector('#pass-save-btn')?.addEventListener('click', async () => {
      const msg = root.querySelector('#pass-msg') as HTMLElement
      const current = (root.querySelector('#pass-current') as HTMLInputElement).value
      const next = (root.querySelector('#pass-new') as HTMLInputElement).value
      const confirm2 = (root.querySelector('#pass-confirm') as HTMLInputElement).value
      if (!current || !next) { msg.textContent = 'Fill in all fields'; msg.className = 'msg msg-err'; return }
      if (next !== confirm2) { msg.textContent = 'New passwords do not match'; msg.className = 'msg msg-err'; return }
      try {
        await api.changePassword(current, next)
        msg.textContent = 'Password updated'; msg.className = 'msg msg-ok'
        ;(root.querySelector('#pass-current') as HTMLInputElement).value = ''
        ;(root.querySelector('#pass-new') as HTMLInputElement).value = ''
        ;(root.querySelector('#pass-confirm') as HTMLInputElement).value = ''
      } catch (e: any) {
        msg.textContent = e.message.includes('401') ? 'Current password is wrong' : 'Update failed: ' + e.message
        msg.className = 'msg msg-err'
      }
    })

    // Join table (cards)
    root.querySelectorAll('#tables-grid [data-join]').forEach(el => {
      el.addEventListener('click', () => {
        const id = (el as HTMLElement).dataset.join!
        const table = tables.find(t => t.id === id)
        if (table) onJoin(table)
      })
    })
    root.querySelectorAll('#tables-grid [data-del]').forEach(el => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation()
        const id = (el as HTMLElement).dataset.del!
        if (confirm('Delete this table and all its data?')) {
          await api.deleteTable(id)
          render()
        }
      })
    })

    if (isAdmin) {
      // Version line: frontend (build-time) + backend (API)
      api.getVersion()
        .then(v => {
          const el = root.querySelector('#version-info')
          if (el) el.textContent = `frontend v${__APP_VERSION__} · backend v${v.version}`
        })
        .catch(() => {})

      root.querySelectorAll('[data-page]').forEach(btn => {
        btn.addEventListener('click', () => {
          adminPage = (btn as HTMLElement).dataset.page as AdminPage
          root.querySelectorAll('[data-page]').forEach(b => b.classList.toggle('active', b === btn))
          renderAdminPage()
        })
      })
      renderAdminPage()
    }
  }

  // ── Admin pages ────────────────────────────────────────────────────────────

  function renderAdminPage() {
    const page = root.querySelector('#admin-page') as HTMLElement | null
    if (!page) return
    if (adminPage === 'tables') void renderTablesPage(page)
    else if (adminPage === 'users') void renderUsersPage(page)
    else void renderAssetsPage(page)
  }

  /** Page 1: create/import tables + inventory of existing maps. */
  async function renderTablesPage(page: HTMLElement) {
    const tables = await api.listTables()
    page.innerHTML = `
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
        <h3>Maps (${tables.length})</h3>
        ${tables.length === 0 ? '<div class="empty-state">No tables yet.</div>' : `
        <table class="data-table">
          <thead>
            <tr><th>Name</th><th>Floors</th><th>Tokens</th><th>Portals</th><th>Map image</th><th></th></tr>
          </thead>
          <tbody>
            ${tables.map(t => `
              <tr>
                <td>${esc(t.name)}</td>
                <td>${t.floor_count ?? 1}</td>
                <td>${t.token_count ?? '—'}</td>
                <td>${t.portal_count ?? '—'}</td>
                <td>${t.map_image_path ? '✓' : '—'}</td>
                <td class="row-actions">
                  <button class="btn btn-primary btn-sm" data-mjoin="${t.id}">Join</button>
                  <button class="btn btn-ghost btn-sm" data-mfloors="${t.id}">Floors</button>
                  <button class="btn btn-ghost btn-sm" data-mren="${t.id}">Rename</button>
                  <button class="btn btn-danger btn-sm" data-mdel="${t.id}">Delete</button>
                </td>
              </tr>
              <tr class="floors-detail" data-floors-for="${t.id}" style="display:none">
                <td colspan="6" style="background:var(--bg);padding:12px 12px 16px">
                  <div class="msg" style="margin:0 0 8px">Loading floors…</div>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>`}
      </div>
    `

    const refresh = () => { void render() }

    page.querySelector('#create-table-btn')?.addEventListener('click', async () => {
      const name = (page.querySelector('#new-table-name') as HTMLInputElement).value.trim()
      const gridSize = parseInt((page.querySelector('#new-table-grid') as HTMLInputElement).value) || 70
      const msg = page.querySelector('#create-table-msg') as HTMLElement
      if (!name) { msg.textContent = 'Enter a table name'; msg.className = 'msg msg-err'; return }
      try {
        await api.createTable(name, gridSize)
        msg.textContent = 'Table created!'; msg.className = 'msg msg-ok'
        setTimeout(refresh, 600)
      } catch (e: any) {
        msg.textContent = e.message; msg.className = 'msg msg-err'
      }
    })

    const dropZone = page.querySelector('#uvtt-drop') as HTMLElement
    const fileInput = page.querySelector('#uvtt-file') as HTMLInputElement
    const importMsg = page.querySelector('#import-msg') as HTMLElement
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

    page.querySelectorAll('[data-mjoin]').forEach(el => {
      el.addEventListener('click', () => {
        const t = tables.find(x => x.id === (el as HTMLElement).dataset.mjoin)
        if (t) onJoin(t)
      })
    })
    page.querySelectorAll('[data-mren]').forEach(el => {
      el.addEventListener('click', async () => {
        const id = (el as HTMLElement).dataset.mren!
        const current = tables.find(x => x.id === id)?.name ?? ''
        const name = prompt('New table name:', current)?.trim()
        if (!name || name === current) return
        try {
          await api.updateTable(id, { name })
          refresh()
        } catch (e: any) {
          alert('Rename failed: ' + e.message)
        }
      })
    })

    page.querySelectorAll('[data-mdel]').forEach(el => {
      el.addEventListener('click', async () => {
        const id = (el as HTMLElement).dataset.mdel!
        if (confirm('Delete this table and all its data?')) {
          await api.deleteTable(id)
          refresh()
        }
      })
    })

    page.querySelectorAll('[data-mfloors]').forEach(el => {
      el.addEventListener('click', async () => {
        const id = (el as HTMLElement).dataset.mfloors!
        const detail = page.querySelector(`[data-floors-for="${id}"]`) as HTMLElement | null
        if (!detail) return
        if (detail.style.display !== 'none') { detail.style.display = 'none'; return }
        detail.style.display = ''
        void renderFloorsDetail(id, detail)
      })
    })
  }

  /** Inline floor manager under a map row: list, rename, image, delete, add. */
  async function renderFloorsDetail(tableId: string, detail: HTMLElement) {
    const cell = detail.querySelector('td')!
    const reload = () => void renderFloorsDetail(tableId, detail)

    let floors: Floor[]
    try {
      const t = await api.getTable(tableId)
      floors = t.floors ?? []
    } catch (e: any) {
      cell.innerHTML = `<div class="msg msg-err">Failed to load floors: ${esc(e.message)}</div>`
      return
    }

    const floorName = (f: Floor) => f.name || `Floor ${f.level}`

    cell.innerHTML = `
      <table class="data-table">
        <thead><tr><th>Level</th><th>Name</th><th>Grid</th><th>Image</th><th></th></tr></thead>
        <tbody>
          ${floors.map(f => `
            <tr>
              <td>${f.level}</td>
              <td>${esc(floorName(f))}</td>
              <td>${f.grid_size} px/sq</td>
              <td>${f.map_image_path
                ? `${f.img_width && f.img_height ? `${f.img_width}×${f.img_height}` : '✓'}`
                : '— <button class="btn btn-ghost btn-sm" data-fimg="${f.id}">Upload image</button>'}</td>
              <td class="row-actions">
                <button class="btn btn-ghost btn-sm" data-fren="${f.id}">Rename</button>
                <button class="btn btn-danger btn-sm" data-fdel="${f.id}" ${floors.length <= 1 ? 'disabled' : ''}>Delete</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
      <div class="form-row" style="margin-top:10px">
        <button class="btn btn-primary btn-sm" data-fadd>+ Add floor</button>
        <button class="btn btn-ghost btn-sm" data-fimport>Import UVTT as floor</button>
        <input type="file" data-ffile accept=".uvtt,.zip,.dd2vtt" style="display:none" />
      </div>
      <div class="msg" data-fmsg style="margin-top:6px">All floor images must share the same dimensions. Stairs between floors are placed from the map page (🪜 tool).</div>
    `

    const msg = cell.querySelector('[data-fmsg]') as HTMLElement
    const say = (text: string, ok = false) => { msg.textContent = text; msg.className = 'msg ' + (ok ? 'msg-ok' : 'msg-err') }

    cell.querySelectorAll('[data-fren]').forEach(el => {
      el.addEventListener('click', async () => {
        const id = (el as HTMLElement).dataset.fren!
        const floor = floors.find(f => f.id === id)
        const name = prompt('Floor name (empty = "Floor N"):', floor?.name ?? '')?.trim()
        if (name === null || name === (floor?.name ?? '')) return
        try { await api.updateFloor(id, { name }); reload() } catch (e: any) { say(e.message) }
      })
    })

    cell.querySelectorAll('[data-fdel]').forEach(el => {
      el.addEventListener('click', async () => {
        const id = (el as HTMLElement).dataset.fdel!
        if (!confirm('Delete this floor with its tokens, doors, fog and stairs?')) return
        try { await api.deleteFloor(id); reload() } catch (e: any) { say(e.message) }
      })
    })

    cell.querySelectorAll('[data-fimg]').forEach(el => {
      el.addEventListener('click', () => {
        const id = (el as HTMLElement).dataset.fimg!
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'image/*'
        input.addEventListener('change', async () => {
          const file = input.files?.[0]
          if (!file) return
          say('Uploading…')
          try {
            // Measure client-side: the server enforces identical dimensions
            // across all floor images of the table.
            const bmp = await createImageBitmap(file)
            const { width, height } = bmp
            bmp.close()
            await api.uploadFloorImage(id, file, width, height)
            say('Floor image updated!', true)
            reload()
          } catch (e: any) { say('Upload failed: ' + e.message) }
        })
        input.click()
      })
    })

    cell.querySelector('[data-fadd]')?.addEventListener('click', async () => {
      const name = prompt('New floor name (e.g. "Cellar", empty = auto):', '')?.trim() ?? ''
      try { await api.createFloor(tableId, { name }); reload() } catch (e: any) { say(e.message) }
    })

    const fileInput = cell.querySelector('[data-ffile]') as HTMLInputElement
    cell.querySelector('[data-fimport]')?.addEventListener('click', () => fileInput.click())
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0]
      if (!file) return
      say('Importing…')
      try {
        await api.importFloorUVTT(tableId, file)
        say('Floor imported!', true)
        reload()
      } catch (e: any) { say('Import failed: ' + e.message) }
    })
  }

  /** Page 2: user management (roles, password resets). */
  async function renderUsersPage(page: HTMLElement) {
    const users = await api.listUsers()
    page.innerHTML = `
      <div class="admin-section">
        <h3>Users</h3>
        <div class="form-row" style="margin-bottom:20px">
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
        <table class="data-table">
          <thead>
            <tr><th>Username</th><th>Role</th><th></th></tr>
          </thead>
          <tbody>
            ${users.map(u => `
              <tr>
                <td>${esc(u.username)}${u.username === user.username ? ' <span class="you">(you)</span>' : ''}</td>
                <td>
                  ${u.username === user.username ? esc(u.role) : `
                  <select data-role-user="${esc(u.username)}">
                    <option value="player" ${u.role === 'player' ? 'selected' : ''}>player</option>
                    <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin</option>
                  </select>`}
                </td>
                <td class="row-actions">
                  <button class="btn btn-ghost btn-sm" data-reset-pass="${esc(u.username)}">Reset password</button>
                  <button class="btn btn-danger btn-sm" data-del-user="${esc(u.username)}" ${u.username === user.username ? 'disabled' : ''}>Delete</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
        <div class="msg" id="user-msg"></div>
      </div>
    `

    const msg = page.querySelector('#user-msg') as HTMLElement
    const refresh = () => void renderUsersPage(page)

    page.querySelector('#create-user-btn')?.addEventListener('click', async () => {
      const name = (page.querySelector('#new-user-name') as HTMLInputElement).value.trim()
      const pass = (page.querySelector('#new-user-pass') as HTMLInputElement).value
      const role = (page.querySelector('#new-user-role') as HTMLSelectElement).value
      if (!name || !pass) { msg.textContent = 'Fill in username and password'; msg.className = 'msg msg-err'; return }
      try {
        await api.createUser(name, pass, role)
        msg.textContent = 'User created!'; msg.className = 'msg msg-ok'
        setTimeout(refresh, 500)
      } catch (e: any) {
        msg.textContent = e.message; msg.className = 'msg msg-err'
      }
    })

    page.querySelectorAll('[data-role-user]').forEach(el => {
      el.addEventListener('change', async () => {
        const username = (el as HTMLElement).dataset.roleUser!
        const role = (el as HTMLSelectElement).value
        try {
          await api.updateUserRole(username, role)
          msg.textContent = `${username} is now ${role}`; msg.className = 'msg msg-ok'
        } catch (e: any) {
          msg.textContent = e.message; msg.className = 'msg msg-err'
          refresh()
        }
      })
    })

    page.querySelectorAll('[data-reset-pass]').forEach(el => {
      el.addEventListener('click', async () => {
        const username = (el as HTMLElement).dataset.resetPass!
        const newPassword = prompt(`New password for "${username}":`)
        if (!newPassword) return
        try {
          await api.resetUserPassword(username, newPassword)
          msg.textContent = `Password reset for ${username}`; msg.className = 'msg msg-ok'
        } catch (e: any) {
          msg.textContent = e.message; msg.className = 'msg msg-err'
        }
      })
    })

    page.querySelectorAll('[data-del-user]').forEach(el => {
      el.addEventListener('click', async () => {
        const username = (el as HTMLElement).dataset.delUser!
        if (confirm(`Delete user "${username}"?`)) {
          try {
            await api.deleteUser(username)
            refresh()
          } catch (e: any) {
            msg.textContent = e.message; msg.className = 'msg msg-err'
          }
        }
      })
    })
  }

  /** Page 3: shared asset library with folders. */
  // Folders start folded; unfold state is remembered across refreshes of the
  // page (it lives outside renderAssetsPage) but resets when leaving the tab.
  const expandedFolders = new Set<string>()

  async function renderAssetsPage(page: HTMLElement) {
    const [images, audios] = await Promise.all([api.listAssets('image'), api.listAssets('audio')])
    const all = [...images, ...audios]
    const folders = [...new Set(all.map(a => a.folder).filter(Boolean))].sort()

    const folderSelect = (a: Asset) => `
      <select data-folder="${esc(a.id)}">
        <option value="" ${a.folder === '' ? 'selected' : ''}>— root —</option>
        ${folders.map(f => `<option value="${esc(f)}" ${a.folder === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}
      </select>`

    const assetRows = (kind: 'image' | 'audio') => {
      const list = kind === 'image' ? images : audios
      if (list.length === 0) return '<div class="empty-state">Nothing uploaded yet.</div>'
      const groups = new Map<string, Asset[]>()
      for (const a of list) {
        if (!groups.has(a.folder)) groups.set(a.folder, [])
        groups.get(a.folder)!.push(a)
      }
      const rows: string[] = []
      for (const folder of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
        const key = `${kind}:${folder}`
        const open = expandedFolders.has(key)
        rows.push(`<tr class="folder-head" data-fold="${esc(key)}">
          <td colspan="4" style="color:var(--brand);font-weight:600;border-bottom:1px solid var(--border)"><span class="fold-arrow">${open ? '▾' : '▸'}</span>📁 ${folder === '' ? 'Root' : esc(folder)} (${groups.get(folder)!.length})</td>
        </tr>`)
        for (const a of groups.get(folder)!) {
          rows.push(`
            <tr class="folder-row" data-group="${esc(key)}" ${open ? '' : 'hidden'}>
              <td>${kind === 'image' ? `<img src="${esc(a.path)}" alt="" style="width:20px;height:20px;border-radius:4px;object-fit:cover;vertical-align:middle;margin-right:8px">` : '<span style="color:var(--accent);margin-right:8px">♪</span>'}${esc(a.name)}</td>
              <td>${formatSize(a.size)}</td>
              <td>${folderSelect(a)}</td>
              <td class="row-actions"><button class="btn btn-danger btn-sm" data-del-asset="${esc(a.id)}">Delete</button></td>
            </tr>`)
        }
      }
      return rows.join('')
    }

    page.innerHTML = `
      <div class="admin-section">
        <h3>Upload Asset</h3>
        <div class="form-row">
          <div class="form-field">
            <label>Files</label>
            <input type="file" id="asset-file" multiple />
          </div>
          <div class="form-field">
            <label>Kind</label>
            <select id="asset-kind">
              <option value="image">Image (token icons)</option>
              <option value="audio">Audio (music)</option>
            </select>
          </div>
          <div class="form-field">
            <label>Folder</label>
            <input id="asset-folder" list="asset-folders" placeholder="(root)" style="width:140px" />
            <datalist id="asset-folders">
              ${folders.map(f => `<option value="${esc(f)}"></option>`).join('')}
            </datalist>
          </div>
          <button class="btn btn-primary" id="asset-upload-btn">Upload</button>
        </div>
        <div class="msg" id="asset-msg"></div>
      </div>

      <div class="admin-section">
        <h3>Token Images (${images.length})</h3>
        <table class="data-table">
          <thead><tr><th>Name</th><th>Size</th><th>Folder</th><th></th></tr></thead>
          <tbody>${assetRows('image')}</tbody>
        </table>
      </div>

      <div class="admin-section">
        <h3>Music (${audios.length})</h3>
        <table class="data-table">
          <thead><tr><th>Name</th><th>Size</th><th>Folder</th><th></th></tr></thead>
          <tbody>${assetRows('audio')}</tbody>
        </table>
      </div>
    `

    const msg = page.querySelector('#asset-msg') as HTMLElement
    const refresh = () => void renderAssetsPage(page)

    page.querySelectorAll('.folder-head').forEach(el => {
      el.addEventListener('click', () => {
        const key = (el as HTMLElement).dataset.fold!
        if (expandedFolders.has(key)) expandedFolders.delete(key)
        else expandedFolders.add(key)
        const open = expandedFolders.has(key)
        el.querySelector('.fold-arrow')!.textContent = open ? '▾' : '▸'
        page.querySelectorAll(`.folder-row[data-group="${CSS.escape(key)}"]`).forEach(r => { (r as HTMLElement).hidden = !open })
      })
    })

    page.querySelector('#asset-upload-btn')?.addEventListener('click', async () => {
      const files = [...((page.querySelector('#asset-file') as HTMLInputElement).files ?? [])]
      const kind = (page.querySelector('#asset-kind') as HTMLSelectElement).value as 'image' | 'audio'
      const folder = (page.querySelector('#asset-folder') as HTMLInputElement).value.trim()
      if (files.length === 0) { msg.textContent = 'Choose at least one file'; msg.className = 'msg msg-err'; return }
      let uploaded = 0, duplicates = 0
      const errors: string[] = []
      for (const file of files) {
        msg.textContent = `Uploading ${uploaded + duplicates + errors.length + 1}/${files.length}: ${file.name}…`; msg.className = 'msg'
        try {
          const asset = await api.uploadAsset(file, kind)
          if (folder && asset.folder !== folder) await api.updateAsset(asset.id, { folder })
          if (asset.existing) duplicates++; else uploaded++
        } catch (e: any) {
          errors.push(`${file.name}: ${e.message || 'failed'}`)
        }
      }
      const summary = [uploaded > 0 ? `${uploaded} uploaded` : '', duplicates > 0 ? `${duplicates} duplicate${duplicates > 1 ? 's' : ''} skipped` : '', errors.length > 0 ? `${errors.length} failed` : ''].filter(Boolean).join(' · ')
      msg.textContent = summary || 'Nothing to upload'
      msg.className = errors.length > 0 ? 'msg msg-err' : 'msg msg-ok'
      if (errors.length > 0) msg.title = errors.join('\n')
      if (uploaded > 0 || duplicates > 0) setTimeout(refresh, 500)
    })

    page.querySelectorAll('[data-folder]').forEach(el => {
      el.addEventListener('change', async () => {
        const id = (el as HTMLElement).dataset.folder!
        const folder = (el as HTMLSelectElement).value
        try {
          await api.updateAsset(id, { folder })
          refresh()
        } catch (e: any) {
          msg.textContent = e.message; msg.className = 'msg msg-err'
        }
      })
    })

    page.querySelectorAll('[data-del-asset]').forEach(el => {
      el.addEventListener('click', async () => {
        const id = (el as HTMLElement).dataset.delAsset!
        if (!confirm('Delete this asset?')) return
        try {
          await api.deleteAsset(id)
          refresh()
        } catch (e: any) {
          msg.textContent = e.message || 'Delete failed'; msg.className = 'msg msg-err'
        }
      })
    })
  }

  render()
}

function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function tableCardHTML(t: Table, isAdmin: boolean) {
  return `
    <div class="table-card">
      <div class="table-card-name">${esc(t.name)}</div>
      <div class="table-card-meta">${t.floor_count && t.floor_count > 1 ? `${t.floor_count} floors` : `Grid: ${t.grid_size ?? 70}px/sq`}</div>
      <div class="table-card-actions">
        <button class="btn btn-primary btn-sm" data-join="${t.id}">Join</button>
        ${isAdmin ? `<button class="btn btn-danger btn-sm" data-del="${t.id}">Delete</button>` : ''}
      </div>
    </div>
  `
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
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
