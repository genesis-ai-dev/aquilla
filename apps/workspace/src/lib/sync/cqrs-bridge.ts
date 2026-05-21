// Phase 2c-gamma slim shim. The original cqrs-bridge.ts threaded the
// active project/file into Y.Doc-coupled writers (commitCellEdit, etc.).
// All those writers are gone in this build. What remains is a thin
// per-file sync-token fetcher and a workspace-scoped bridge identity
// (projectId / activeFileId / username) that callers still read for
// per-file rooms and event authorship. The actual writes flow through
// events-emit.ts now.

import {
  makeSyncTokenFetcher,
  type ProjectBootstrap,
  type SyncTokenCallbacks,
} from "./sync-token"

export interface CqrsOutboxBridge {
  projectId: string
  /** Active editor file — event payloads are scoped to this file. */
  activeFileId: string | null
  username: string
}

let bridge: CqrsOutboxBridge | null = null

export function setCqrsOutboxBridge(next: CqrsOutboxBridge | null): void {
  bridge = next
}

export function getCqrsOutboxBridge(): CqrsOutboxBridge | null {
  return bridge
}

export function buildFileScopedTokenFetcher(
  getJwt: () => string | null,
  projectId: string,
  bootstrap: ProjectBootstrap = {},
  apiUrl?: string,
  callbacks: SyncTokenCallbacks = {},
): (fileId: string) => Promise<string | null> {
  const cache = new Map<string, () => Promise<string | null>>()
  return (fileId: string) => {
    let fetcher = cache.get(fileId)
    if (!fetcher) {
      fetcher = makeSyncTokenFetcher(
        getJwt,
        projectId,
        fileId,
        bootstrap,
        apiUrl,
        callbacks,
      )
      cache.set(fileId, fetcher)
    }
    return fetcher()
  }
}
