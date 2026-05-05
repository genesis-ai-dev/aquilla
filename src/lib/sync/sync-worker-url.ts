import { SYNC_WORKER_HOST } from "./partyserver-provider"

function isLocalHost(host: string): boolean {
  return /^(127\.|localhost|0\.0\.0\.0)/.test(host)
}

/** HTTPS (prod) or HTTP (local wrangler dev) origin for sync-worker REST routes. */
export function syncWorkerHttpOrigin(): string {
  const protocol = isLocalHost(SYNC_WORKER_HOST) ? "http" : "https"
  return `${protocol}://${SYNC_WORKER_HOST}`
}
