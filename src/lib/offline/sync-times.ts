// When this device last uploaded an offline-queued edit for a project. The
// LiveStore `offline_projects.syncedAt` column already records the last
// download (catch-up / initial download); uploads had no timestamp, so the
// status chip could not say how stale the server's copy of local work is.
// Kept in localStorage rather than a new LiveStore column: it is a per-device
// display hint, and a schema change would need an eventlog migration.
import { useEffect, useState, useSyncExternalStore } from "react"
import type { Store } from "@livestore/livestore"
import { tables, type schema } from "./schema"

const KEY_PREFIX = "aquilla.offline.lastUploadAt."
const listeners = new Set<() => void>()

export function readLastUploadAt(projectId: string): Date | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + projectId)
    const ms = raw ? Number(raw) : NaN
    return Number.isFinite(ms) ? new Date(ms) : null
  } catch {
    return null
  }
}

export function recordOfflineUpload(projectId: string, at: Date = new Date()): void {
  try {
    localStorage.setItem(KEY_PREFIX + projectId, String(at.getTime()))
  } catch {
    // Storage blocked — the chip just shows "never".
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useLastUploadAt(projectId: string | null | undefined): number | null {
  return useSyncExternalStore(
    subscribe,
    () => (projectId ? (readLastUploadAt(projectId)?.getTime() ?? null) : null),
    () => null,
  )
}

/** Last download for an offline-ready project (`offline_projects.syncedAt`,
 *  set by the initial download and every catch-up). Null when the project is
 *  not downloaded for offline use. */
export function useLastDownloadAt(
  store: Store<typeof schema> | null,
  projectId: string | null | undefined,
): number | null {
  const [value, setValue] = useState<{ key: string; at: number | null } | null>(null)
  useEffect(() => {
    if (!store || !projectId) return
    const query = tables.offlineProjects.select("syncedAt").where({ projectId })
    return store.subscribe(query, (rows) => {
      const at = rows[0] ? rows[0].getTime() : null
      setValue((prev) => (prev?.key === projectId && prev.at === at ? prev : { key: projectId, at }))
    })
  }, [store, projectId])
  return store && projectId && value?.key === projectId ? value.at : null
}
