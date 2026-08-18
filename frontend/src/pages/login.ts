/** Login page: posts credentials, stores the JWT in localStorage. */
import { api } from '../api/client'
import type { User } from '../types'

export function renderLogin(root: HTMLElement, onLogin: (user: User) => void) {
  root.innerHTML = `
    <style>
      .login-wrap {
        display: flex; align-items: center; justify-content: center;
        height: 100%; background: var(--bg);
      }
      .login-box {
        background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
        padding: 40px 48px; width: 360px; box-shadow: 0 8px 32px rgba(30,33,28,0.25);
      }
      .login-logo {
        display: flex; align-items: center; gap: 12px;
        font-family: var(--font-title); font-size: 25px; font-weight: 700;
        color: var(--text); margin-bottom: 32px;
      }
      .login-logo svg { flex-shrink: 0; }
      .login-field { margin-bottom: 16px; }
      .login-field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.05em; }
      .login-field input {
        width: 100%; padding: 10px 14px; background: var(--bg);
        border: 1px solid var(--border); border-radius: 8px; color: var(--text);
        font-size: 15px; outline: none; transition: border-color 0.2s;
      }
      .login-field input:focus { border-color: var(--accent); }
      .login-btn {
        width: 100%; padding: 11px; background: var(--brand); border: none;
        border-radius: 8px; color: var(--on-brand); font-size: 15px; font-weight: 600;
        cursor: pointer; margin-top: 8px; transition: background 0.2s;
      }
      .login-btn:hover { background: var(--brand-hover); }
      .login-btn:disabled { opacity: 0.5; cursor: default; }
      .login-err { color: var(--danger); font-size: 13px; margin-top: 10px; min-height: 18px; }
    </style>
    <div class="login-wrap">
      <div class="login-box">
        <div class="login-logo">
          <svg width="32" height="32" viewBox="0 0 64 64" fill="none">
            <rect width="64" height="64" rx="8" fill="#1E211C"/>
            <polygon points="32,8 56,48 8,48" stroke="#9A7656" stroke-width="3" fill="none"/>
            <circle cx="32" cy="32" r="6" fill="#9A7656"/>
          </svg>
          RHW Simple VTT
        </div>
        <form id="login-form">
          <div class="login-field">
            <label>Username</label>
            <input id="login-user" type="text" autocomplete="username" required />
          </div>
          <div class="login-field">
            <label>Password</label>
            <input id="login-pass" type="password" autocomplete="current-password" required />
          </div>
          <button class="login-btn" type="submit">Sign in</button>
          <div class="login-err" id="login-err"></div>
        </form>
      </div>
    </div>
  `

  const form = root.querySelector('#login-form') as HTMLFormElement
  const errEl = root.querySelector('#login-err') as HTMLElement
  const btn = root.querySelector('.login-btn') as HTMLButtonElement

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const username = (root.querySelector('#login-user') as HTMLInputElement).value.trim()
    const password = (root.querySelector('#login-pass') as HTMLInputElement).value
    errEl.textContent = ''
    btn.disabled = true

    try {
      const { token, user } = await api.login(username, password)
      localStorage.setItem('token', token)
      onLogin(user)
    } catch (err: any) {
      errEl.textContent = 'Invalid username or password'
      btn.disabled = false
    }
  })
}
