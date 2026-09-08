/** Login page — VIEW of LoginViewModel (MVVM). Renders state, forwards
 *  user input to the ViewModel; contains no login logic itself. */
import { LoginViewModel } from '../viewmodels/login.viewmodel'
import loginHtml from '../views/login.html?raw'
import type { User } from '../types'

export function renderLogin(root: HTMLElement, onLogin: (user: User) => void) {
  const vm = new LoginViewModel()

  root.innerHTML = loginHtml

  const form = root.querySelector('#login-form') as HTMLFormElement
  const errEl = root.querySelector('#login-err') as HTMLElement
  const btn = root.querySelector('.login-btn') as HTMLButtonElement
  const userInput = root.querySelector('#login-user') as HTMLInputElement
  const passInput = root.querySelector('#login-pass') as HTMLInputElement

  // View -> ViewModel: forward inputs and submits
  userInput.addEventListener('input', () => vm.username.set(userInput.value))
  passInput.addEventListener('input', () => vm.password.set(passInput.value))
  form.addEventListener('submit', e => { e.preventDefault(); void vm.login() })

  // ViewModel -> View: project state changes
  vm.error.subscribe(err => { errEl.textContent = err })
  vm.busy.subscribe(busy => { btn.disabled = busy })
  vm.user.subscribe(user => { if (user) onLogin(user) })
}
