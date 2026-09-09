/**
 * MVVM — minimal observable primitive shared by all ViewModels.
 *
 * The app has no framework: views are imperative render functions. An
 * Observable lets a ViewModel own state and notify the view when it changes,
 * so views never store presentation state themselves and ViewModels never
 * touch the DOM.
 */
export class Observable<T> {
  private value: T
  private readonly subscribers = new Set<(v: T) => void>()

  constructor(initial: T) {
    this.value = initial
  }

  get(): T {
    return this.value
  }

  set(v: T): void {
    if (v === this.value) return
    this.value = v
    this.subscribers.forEach(fn => fn(v))
  }

  update(fn: (v: T) => T): void {
    this.set(fn(this.value))
  }

  subscribe(fn: (v: T) => void): () => void {
    this.subscribers.add(fn)
    return () => { this.subscribers.delete(fn) }
  }
}
