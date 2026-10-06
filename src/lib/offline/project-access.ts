// Tracks downloaded offline projects the server has stopped letting this
// device sync: deleted (a dev DB refresh, say), the user's membership
// removed, or the project archived / frozen. auth-worker answers all of these
// with the same sync-token 403 (auth-worker/src/routes/sync-token.ts — an
// unknown project is deliberately indistinguishable from one the caller can't
// access), and with a 5xx for anything transient, so one 403 is a real
// verdict rather than a blip. Sync tokens live 15 minutes, so the mark can
// lag a removal by up to that long.
//
// Without this, the adapter just retried forever: catch-up silently returned,
// queued writes backed off and retried, and the local copy stayed "ready" but
// frozen in time with nothing telling the user. The project usually isn't in
// the server's project list any more either, so no per-project UI could show
// it.
//
// In-memory on purpose, not a LiveStore column: it is re-learned within
// seconds of every (re)connect, and a schema change carries the downgrade
// hazard of wiping the local store. A later 200 clears the mark, since
// archive and freeze are reversible and access can be re-granted. Queued
// writes are left untouched — they go out if access comes back.
//
// Mirrors the listener pattern in ./leader-watchdog.ts.
import { useSyncExternalStore } from "react"
import type { MintToken } from "./sync-adapter"

const unavailable = new Set<string>()
let snapshot: readonly string[] = []
const listeners = new Set<() => void>()

function emit(): void {
  snapshot = [...unavailable]
  for (const cb of listeners) cb()
}

export function markProjectUnavailable(projectId: string): void {
  if (unavailable.has(projectId)) return
  unavailable.add(projectId)
  emit()
}

export function markProjectAvailable(projectId: string): void {
  if (!unavailable.delete(projectId)) return
  emit()
}

export function isProjectUnavailable(projectId: string): boolean {
  return unavailable.has(projectId)
}

/** Stable between changes, so it is safe as a useSyncExternalStore snapshot. */
export function getUnavailableProjects(): readonly string[] {
  return snapshot
}

export function subscribeProjectAccess(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** React binding — offline project ids the server currently refuses to sync. */
export function useUnavailableProjects(): readonly string[] {
  return useSyncExternalStore(subscribeProjectAccess, getUnavailableProjects, getUnavailableProjects)
}

/**
 * Wraps a token minter so every mint reports what it learned: 403 marks the
 * project unavailable, success clears it. Anything else (401 expired session,
 * 5xx, no network, signed out) says nothing about the project and leaves the
 * mark as it was.
 */
export function withAccessTracking(mint: MintToken): MintToken {
  return async (projectId, fileId) => {
    const result = await mint(projectId, fileId)
    if (result.token) markProjectAvailable(projectId)
    else if (result.status === 403) markProjectUnavailable(projectId)
    return result
  }
}

/** Test-only: forget every mark. */
export function resetProjectAccessForTests(): void {
  unavailable.clear()
  emit()
}
