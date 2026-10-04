/** First-start setup wizard — VIEW of SetupViewModel (MVVM). Renders the
 *  choose/credentials/restore/wait modes and forwards input; contains no
 *  setup logic itself. */
import { SetupViewModel, SetupMode } from '../viewmodels/setup.viewmodel'
import setupHtml from '../views/setup.html?raw'
import setupCss from '../styles/setup.css?raw'
import loginCss from '../styles/login.css?raw'
import type { User } from '../types'

export function renderSetup(root: HTMLElement, onReady: (user: User | null) => void) {
  const vm = new SetupViewModel()

  root.innerHTML = `<style>${loginCss}${setupCss}</style>` + setupHtml

  const $ = (sel: string) => root.querySelector(sel) as HTMLElement
  const panels: Record<SetupMode, string> = {
    choose: '#setup-choose',
    credentials: '#setup-credentials',
    restore: '#setup-restore',
    wait: '#setup-wait',
  }

  function show(mode: SetupMode) {
    for (const [m, sel] of Object.entries(panels)) {
      $(sel).hidden = m !== mode
    }
  }

  // View -> ViewModel: mode switching
  $('#setup-go-credentials').addEventListener('click', () => { vm.choose('credentials'); show('credentials') })
  $('#setup-go-restore').addEventListener('click', () => { vm.choose('restore'); show('restore') })
  $('#setup-cred-back').addEventListener('click', () => { vm.choose('choose'); show('choose') })
  $('#setup-restore-back').addEventListener('click', () => { vm.choose('choose'); show('choose') })

  // Credentials path
  const credForm = $('#setup-credentials') as HTMLFormElement
  $('#setup-user').addEventListener('input', e => vm.username.set((e.target as HTMLInputElement).value))
  $('#setup-pass').addEventListener('input', e => vm.password.set((e.target as HTMLInputElement).value))
  credForm.addEventListener('submit', e => { e.preventDefault(); void vm.createAdmin() })

  // Restore path
  const restoreForm = $('#setup-restore') as HTMLFormElement
  let chosenFile: File | null = null
  $('#setup-file').addEventListener('change', e => { chosenFile = (e.target as HTMLInputElement).files?.[0] ?? null })
  restoreForm.addEventListener('submit', e => { e.preventDefault(); void vm.restoreBackup(chosenFile) })

  // ViewModel -> View
  vm.error.subscribe(err => {
    $('#setup-err').textContent = err
    $('#setup-err-restore').textContent = err
  })
  vm.busy.subscribe(busy => {
    const credBtn = credForm.querySelector('.login-btn') as HTMLButtonElement
    const restoreBtn = restoreForm.querySelector('.login-btn') as HTMLButtonElement
    credBtn.disabled = busy
    restoreBtn.disabled = busy
  })
  vm.mode.subscribe(mode => show(mode))
  vm.progress.subscribe(fraction => {
    const pct = Math.round(fraction * 100)
    $('#setup-progress').setAttribute('value', String(pct))
    $('#setup-progress-label').textContent = `${pct}%`
  })
  vm.waitText.subscribe(text => { $('#setup-wait-text').textContent = text })
  vm.user.subscribe(user => { if (user) onReady(user) })
}
