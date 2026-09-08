/**
 * MVVM — ViewModel for the login page.
 *
 * Holds the page's state (credentials, error, busy flag) and the login
 * action. The view renders from this state and subscribes to changes; it
 * contains no logic of its own. On success the VM persists the session and
 * reports the logged-in user through `user`.
 */
import { Observable } from '../mvvm/observable'
import { api } from '../api/client'
import type { User } from '../types'

export class LoginViewModel {
  readonly username = new Observable('')
  readonly password = new Observable('')
  readonly error = new Observable('')
  readonly busy = new Observable(false)
  /** Set once login succeeds — the view reacts by navigating away. */
  readonly user = new Observable<User | null>(null)

  async login(): Promise<void> {
    if (this.busy.get()) return
    this.error.set('')
    this.busy.set(true)
    try {
      const { token, user } = await api.login(this.username.get().trim(), this.password.get())
      localStorage.setItem('token', token)
      this.user.set(user)
    } catch {
      this.error.set('Invalid username or password')
      this.busy.set(false)
    }
  }
}
