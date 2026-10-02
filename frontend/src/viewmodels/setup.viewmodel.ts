/**
 * MVVM — ViewModel for the first-start setup wizard.
 *
 * Holds the wizard's state (mode, form fields, error, busy flag) and the
 * two setup paths: create/adopt the first admin account, or import a
 * whole-instance backup. The restore path runs a wait flow: upload
 * progress, applying/validation, then polling until the restarted server
 * is back — the view redirects to the login page once the restore is
 * confirmed. The view contains no logic of its own.
 */
import { Observable } from '../mvvm/observable'
import { api } from '../api/client'
import type { User } from '../types'

export type SetupMode = 'choose' | 'credentials' | 'restore' | 'wait'
export type WaitPhase = 'uploading' | 'applying' | 'restarting' | 'stuck'

export class SetupViewModel {
  readonly mode = new Observable<SetupMode>('choose')
  readonly username = new Observable('')
  readonly password = new Observable('')
  readonly error = new Observable('')
  readonly busy = new Observable(false)
  /** Set once setup completes — the view reacts by navigating to login/app. */
  readonly user = new Observable<User | null>(null)

  // Restore wait flow
  readonly phase = new Observable<WaitPhase>('uploading')
  /** Upload progress 0..1 (meaningful while phase === 'uploading'). */
  readonly progress = new Observable(0)
  /** One-line explanation of what is currently happening. */
  readonly waitText = new Observable('')

  choose(m: SetupMode): void {
    this.error.set('')
    this.mode.set(m)
  }

  async createAdmin(): Promise<void> {
    if (this.busy.get()) return
    if (this.password.get().length < 4) {
      this.error.set('Password must be at least 4 characters')
      return
    }
    this.error.set('')
    this.busy.set(true)
    try {
      const { token, user } = await api.setupAdmin(this.username.get().trim(), this.password.get())
      localStorage.setItem('token', token)
      this.user.set(user)
    } catch (e) {
      this.error.set(e instanceof Error ? e.message.replace(/^POST \/setup\/admin: \d+ ?/, '') : 'Setup failed')
      this.busy.set(false)
    }
  }

  async restoreBackup(file: File | null): Promise<void> {
    if (this.busy.get()) return
    if (!file) {
      this.error.set('Choose a backup .zip first')
      return
    }
    this.error.set('')
    this.busy.set(true)
    this.progress.set(0)
    this.phase.set('uploading')
    this.waitText.set('Uploading the backup — do not close this page.')
    this.mode.set('wait')

    try {
      await api.setupRestore(file, fraction => {
        this.progress.set(fraction)
        if (fraction >= 1) {
          this.phase.set('applying')
          this.waitText.set('Import received — the server is validating and applying it. This can take a while.')
        }
      })
      this.phase.set('restarting')
      this.waitText.set('Backup applied — waiting for the server to restart…')
      void this.pollAfterRestore()
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Restore failed')
      this.busy.set(false)
      this.mode.set('restore')
    }
  }

  /** Poll setup status until the restarted instance answers with setup
   *  completed, then send the browser to the login page. A restore that
   *  failed server-side keeps the instance INCOMPLETE: the wizard must
   *  stay available, so we surface an error instead of redirecting. */
  private async pollAfterRestore(): Promise<void> {
    const startedAt = Date.now()
    const poll = async (): Promise<'done' | 'incomplete' | 'retry'> => {
      try {
        const status = await api.setupStatus()
        return status.completed ? 'done' : 'incomplete'
      } catch {
        return 'retry' // server down mid-restart — normal, keep waiting
      }
    }
    for (;;) {
      await new Promise(r => setTimeout(r, 2000))
      const state = await poll()
      if (state === 'done') {
        this.waitText.set('Restore complete! Redirecting to the login page…')
        window.location.href = '/login'
        return
      }
      if (state === 'incomplete') {
        // The server rejected or lost the restore — the wizard is still
        // open; tell the user and return to the form.
        this.busy.set(false)
        this.mode.set('restore')
        this.error.set('The server came back without applying the restore (setup is still open). Check the server logs and try again.')
        return
      }
      if (Date.now() - startedAt > 180_000) {
        this.phase.set('stuck')
        this.waitText.set('The server has not come back after 3 minutes. Check the server logs — a manual restart usually completes a pending restore.')
        return
      }
    }
  }
}
