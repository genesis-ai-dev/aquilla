// File-sync provider backed by the codex sync-worker (y-partyserver DO + R2).
// Separate from createSyncProvider in ./webrtc-provider.ts which still serves
// the ephemeral share-link rooms on the older signaling relay. Keep them
// split until the share flow is redesigned for DOs.

import YProvider from "y-partyserver/provider"
import * as Y from "yjs"

const DEFAULT_HOST = "127.0.0.1:8787"

export const SYNC_WORKER_HOST =
  ((import.meta.env.VITE_SYNC_WORKER_HOST as string | undefined) ?? DEFAULT_HOST).replace(
    /^wss?:\/\//,
    ""
  )

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
  fileId: string
): FileSyncProviderHandle {
  const docId = buildFileSyncDocId(projectId, fileId)
  const provider = new YProvider(SYNC_WORKER_HOST, docId, doc, {
    party: "file-sync",
    protocol: isLocalHost(SYNC_WORKER_HOST) ? "ws" : "wss",
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
