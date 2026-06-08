// Phase 2c-gamma slim shim. The original cqrs-bridge.ts threaded the
// active project/file into Y.Doc-coupled writers (commitCellEdit, etc.).
// All those writers are gone in this build. What remains is a thin
// per-file sync-token fetcher and a workspace-scoped bridge identity
// (projectId / activeFileId / username) that callers still read for
// per-file rooms and event authorship. The actual writes flow through
// events-emit.ts now.

import {
  makeSyncTokenFetcher,
  makeSyncTokenMinter,
  type ProjectBootstrap,
  type SyncTokenCallbacks,
  type SyncTokenMintResult,
} from "./sync-token"

export interface CqrsOutboxBridge {
  projectId: string
  /** Active editor file — event payloads are scoped to this file. */
  activeFileId: string | null
  username: string
  /** The signed-in user's role level on this project (from the sync-token
   *  `onRole` callback, persisted as project.syncRole). Used by the emit layer
   *  to refuse events the user provably can't perform (mirrors the server's
   *  role gate) so a guaranteed-403 never enters the outbox. Null = unknown →
   *  fail open and let the server decide. */
  roleLevel?: number | null
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

/**
 * Project-AGNOSTIC token fetcher for the outbox flusher. The outbox is a
 * single global IndexedDB store that accumulates events from every project the
 * user touches; the flusher must mint a token scoped to each EVENT's own
 * project, not the workspace's currently-open project. Minting against the
 * active workspace projectId is what produced "403 token scoped to different
 * project" on events queued in another project — which then head-of-line
 * blocked the entire queue.
 *
 * Internally lazily builds (and caches) a per-project file-scoped fetcher.
 * `bootstrap` is intentionally omitted: re-registration only matters for the
 * project the user is actively in (handled by the workspace fetcher); every
 * other project already exists server-side by the time its events flush.
 */
export function buildProjectAwareTokenFetcher(
  getJwt: () => string | null,
  apiUrl?: string,
  callbacks: SyncTokenCallbacks = {},
): (projectId: string, fileId: string) => Promise<string | null> {
  const perProject = new Map<string, (fileId: string) => Promise<string | null>>()
  return (projectId: string, fileId: string) => {
    let forProject = perProject.get(projectId)
    if (!forProject) {
      forProject = buildFileScopedTokenFetcher(getJwt, projectId, {}, apiUrl, callbacks)
      perProject.set(projectId, forProject)
    }
    return forProject(fileId)
  }
}

/**
 * Status-preserving variant of buildProjectAwareTokenFetcher for the outbox
 * flusher. Returns `{ token, status }` so the flusher can quarantine-and-advance
 * on a permanent mint-403 instead of treating it as a transient blip and
 * head-of-line blocking the queue. Caches a per-(project,file) minter, same as
 * the string fetcher.
 */
export function buildProjectAwareMinter(
  getJwt: () => string | null,
  apiUrl?: string,
  callbacks: SyncTokenCallbacks = {},
): (projectId: string, fileId: string) => Promise<SyncTokenMintResult> {
  const perProject = new Map<string, (fileId: string) => Promise<SyncTokenMintResult>>()
  return (projectId: string, fileId: string) => {
    let forProject = perProject.get(projectId)
    if (!forProject) {
      const cache = new Map<string, () => Promise<SyncTokenMintResult>>()
      forProject = (fid: string) => {
        let minter = cache.get(fid)
        if (!minter) {
          minter = makeSyncTokenMinter(getJwt, projectId, fid, {}, apiUrl, callbacks)
          cache.set(fid, minter)
        }
        return minter()
      }
      perProject.set(projectId, forProject)
    }
    return forProject(fileId)
  }
}
