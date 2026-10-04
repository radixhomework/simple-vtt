/**
 * HTTP entry point: boots the assembled Express app and attaches the
 * WebSocket server. App wiring lives in ./app, routes in ./routes,
 * realtime logic in ./hub.
 *
 * Boot order is strict and async on purpose:
 *   1. storage configuration is validated (a misconfigured deployment
 *      must refuse to start — no server, no database);
 *   2. a pending first-start restore is applied BEFORE ./app's import of
 *      ./db opens the database file;
 *   3. the HTTP server comes up; retired pre-restore files are cleaned
 *      once it is demonstrably listening.
 * The heavy modules are therefore imported dynamically: static imports
 * would execute before the checks.
 */
import { assertStorageReady } from './storage'

async function main(): Promise<void> {
  await assertStorageReady()

  const { applyPendingRestore, cleanupRetiredRestore } = await import('./restore-apply')
  applyPendingRestore()

  const [{ default: app }, { setupWebSocket }, http, { WebSocketServer }] = await Promise.all([
    import('./app'),
    import('./hub'),
    import('http'),
    import('ws'),
  ])

  const port = parseInt(process.env.PORT || '8080', 10)
  const server = http.createServer(app)
  const wss = new WebSocketServer({ server, path: '/ws' })
  setupWebSocket(wss)

  server.listen(port, () => {
    console.log(`Simple VTT listening on :${port}`)
    // The pre-restore state is no longer needed once the app is serving
    cleanupRetiredRestore()
  })
}

main().catch((err: unknown) => {
  console.error('[config] refusing to start:', err instanceof Error ? err.message : err)
  process.exit(1)
})
