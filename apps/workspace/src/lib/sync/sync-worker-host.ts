// Sync-worker host resolution for REST routes and the ProjectSync WebSocket.

// Dev default assumes `cd apps/sync && wrangler dev`. Prod deploys must set
// VITE_SYNC_WORKER_HOST at build time to the deployed worker hostname.
const DEV_HOST = "127.0.0.1:8787"
const PROD_HOST = "codex-sync-worker.blue-darkness-7674.workers.dev"

export const SYNC_WORKER_HOST = (
  (import.meta.env.VITE_SYNC_WORKER_HOST as string | undefined) ??
  (import.meta.env.PROD ? PROD_HOST : DEV_HOST)
).replace(/^wss?:\/\//, "")
