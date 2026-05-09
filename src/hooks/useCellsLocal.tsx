/**
 * Synchronous-shaped read hook over the local SQLite store. Returns
 * `LocalCellData[]` for cells in the given (projectId, scopeId), kept
 * fresh by subscribing to the in-process store-events bus.
 *
 *   const cells = useCellsLocal(store, projectId, scopeId)
 *
 * Subscription strategy: any `cells.changed`, `threads.changed`,
 * `thread_messages.changed`, `waivers.changed`, or
 * `backtranslations.changed` event triggers a re-query. The query
 * itself is cheap (indexed by project_id + scope_id) and the joins
 * scale with the cell count of the current scope, not the whole DB.
 *
 * The hook is safe to call with `store = null` while the
 * LocalStoreProvider is still opening; it returns `[]` and installs
 * no listeners until the store becomes available.
 */

import { useCallback, useEffect, useState } from "react"
import {
  getCellsByScope,
  rowToLocalCellData,
  storeEvents,
  type LocalCellData,
  type LocalStore,
  type StoreEvent,
} from "@/lib/local-store"

const RELEVANT_EVENT_TYPES: ReadonlySet<StoreEvent["type"]> = new Set([
  "cells.changed",
  "threads.changed",
  "thread_messages.changed",
  "waivers.changed",
  "backtranslations.changed",
])

export function useCellsLocal(
  store: LocalStore | null,
  projectId: string | null | undefined,
  scopeId: string | null | undefined,
): LocalCellData[] {
  const [cells, setCells] = useState<LocalCellData[]>([])

  const refresh = useCallback(async () => {
    if (!store || !projectId || !scopeId) {
      setCells([])
      return
    }
    const rows = await getCellsByScope(store, projectId, scopeId)
    const out: LocalCellData[] = []
    for (const row of rows) {
      out.push(await rowToLocalCellData(store, row))
    }
    setCells(out)
  }, [store, projectId, scopeId])

  useEffect(() => {
    if (!store || !projectId || !scopeId) {
      setCells([])
      return
    }
    void refresh()
    const unsub = storeEvents.subscribe((event) => {
      if (RELEVANT_EVENT_TYPES.has(event.type)) {
        void refresh()
      }
    })
    return unsub
  }, [store, projectId, scopeId, refresh])

  return cells
}
