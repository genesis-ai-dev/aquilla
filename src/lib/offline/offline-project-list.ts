// Desktop: the projects one account can open on this device with no connection
// — the offline org pages list these in place of the server directory.
import { useCallback, useRef, useSyncExternalStore } from "react"
import type { Store } from "@livestore/livestore"
import { readProjectSnapshot } from "./project-snapshot"
import { tables, type schema } from "./schema"

export interface OfflineProjectListItem {
  id: string
  name: string
  orgId: number | null
  syncedAt: Date | null
}

/**
 * Downloaded projects `owner` can open offline: ready, and holding a snapshot
 * stored for that account — a project another account downloaded on this
 * device has nothing to build the workspace from (project-snapshot.ts).
 */
export function listOfflineProjects(store: Store<typeof schema>, owner: string): OfflineProjectListItem[] {
  const ready = store.query(tables.offlineProjects.select().where({ status: "ready" }))
  const items: OfflineProjectListItem[] = []
  for (const { projectId, syncedAt } of ready) {
    const snapshot = readProjectSnapshot(store, projectId, owner)
    if (!snapshot) continue
    const row = store.query(tables.projects.select().where({ id: projectId }).first())
    const storedOrgId = row?.orgId ? Number(row.orgId) : NaN
    items.push({
      id: projectId,
      name: row?.name || snapshot.name || projectId,
      orgId: Number.isFinite(storedOrgId) ? storedOrgId : (snapshot.orgId ?? null),
      syncedAt: syncedAt ?? row?.syncedAt ?? null,
    })
  }
  return items.sort((a, b) => a.name.localeCompare(b.name))
}

const NONE: OfflineProjectListItem[] = []

/** {@link listOfflineProjects}, kept current as downloads finish or are removed. */
export function useOfflineProjectList(
  store: Store<typeof schema> | null,
  owner: string | null,
): OfflineProjectListItem[] {
  // useSyncExternalStore wants the same array back until something changed.
  const last = useRef<{ key: string; items: OfflineProjectListItem[] }>({ key: "[]", items: NONE })
  const subscribe = useCallback(
    (onChange: () => void) => (store ? store.subscribe(tables.offlineProjects.select(), onChange) : () => {}),
    [store],
  )
  const getSnapshot = useCallback(() => {
    const items = store && owner ? listOfflineProjects(store, owner) : NONE
    const key = JSON.stringify(items)
    if (key !== last.current.key) last.current = { key, items }
    return last.current.items
  }, [store, owner])
  return useSyncExternalStore(subscribe, getSnapshot)
}
