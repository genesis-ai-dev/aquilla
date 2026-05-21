// Sync-worker host resolution for REST routes and the ProjectSync WebSocket.

// Dev default assumes `cd apps/sync && wrangler dev`. Prod deploys must set
// VITE_SYNC_WORKER_HOST at build time. The value may carry a path segment
// (e.g. `aquilla.app/api/sync`) when the worker is mounted under the apex via
// Workers Routes — `syncWorkerHttpOrigin()` and the WS URL builder preserve it.
const DEV_HOST = "127.0.0.1:8787"
const PROD_HOST = "aquilla.app/api/sync"

export const SYNC_WORKER_HOST = (
  (import.meta.env.VITE_SYNC_WORKER_HOST as string | undefined) ??
  (import.meta.env.PROD ? PROD_HOST : DEV_HOST)
).replace(/^wss?:\/\//, "")
