// File-sync provider backed by the codex sync-worker (y-partyserver DO + R2).
// This is the only sync provider — share-link joiners are added to
// project_members via /api/v2/projects/accept-invite, then sync over the same
// path as any other authenticated member.

import YProvider from "y-partyserver/provider"
import * as Y from "yjs"

// Dev default assumes `cd sync-worker && wrangler dev`. Prod deploys must set
// VITE_SYNC_WORKER_HOST at build time to the deployed worker hostname.
const DEV_HOST = "127.0.0.1:8787"
const PROD_HOST = "codex-sync-worker.blue-darkness-7674.workers.dev"

export const SYNC_WORKER_HOST = (
  (import.meta.env.VITE_SYNC_WORKER_HOST as string | undefined) ??
  (import.meta.env.PROD ? PROD_HOST : DEV_HOST)
).replace(/^wss?:\/\//, "")

function isLocalHost(host: string): boolean {
  return /^(127\.|localhost|0\.0\.0\.0)/.test(host)
}

export function buildFileSyncDocId(projectId: string, fileId: string): string {
  return `${projectId}--${fileId}`
}

export interface FileSyncProviderHandle {
  provider: YProvider
  docId: string
}

export function createFileSyncProvider(
  doc: Y.Doc,
  projectId: string,
  fileId: string,
  getToken?: () => Promise<string | null>
): FileSyncProviderHandle {
  const docId = buildFileSyncDocId(projectId, fileId)
  const provider = new YProvider(SYNC_WORKER_HOST, docId, doc, {
    party: "file-sync",
    protocol: isLocalHost(SYNC_WORKER_HOST) ? "ws" : "wss",
    // y-partyserver calls params on every (re)connect. Returning no token is
    // fine when the sync-worker is running in ALLOW_UNAUTHENTICATED=true dev
    // mode; in prod the WS upgrade will be rejected with 401 and the provider
    // will enter a reconnect backoff — editor still works via IndexedDB.
    params: getToken
      ? async () => {
          const token = await getToken()
          return token ? { token } : {}
        }
      : undefined,
  })
  return { provider, docId }
}

export function destroyFileSyncProvider(handle: FileSyncProviderHandle): void {
  try {
    handle.provider.destroy()
  } catch (err) {
    console.warn("Error destroying file-sync provider:", err)
  }
}
