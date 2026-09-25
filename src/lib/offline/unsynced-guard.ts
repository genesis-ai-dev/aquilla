/**
 * Guards against silent local-write loss on reload/close.
 *
 * Background: a real page reload (Cmd+R) or app auto-update tears down the
 * current LiveStore leader (SharedWorker + dedicated worker) while a freshly
 * loaded page's leader can race it for the same exclusive OPFS access
 * handle. When that race loses, LiveStore's push pipeline throws (observed
 * as a `RejectedPushError`/`InvalidStateError`) and whatever local writes
 * hadn't yet been durably flushed to OPFS are gone — confirmed via manual
 * testing during Phase 3/4. This is a browser/LiveStore lifecycle race, not
 * something app code can close outright (there's no reliable way to block a
 * real navigation until a torn-down worker has released its OPFS lock).
 *
 * What app code CAN do is stop the loss from being silent: warn before a
 * reload/close whenever there's local offline work that hasn't reached the
 * server yet, same `beforeunload` convention as ProjectSettings.tsx's
 * unsaved-changes guard.
 */
import { useEffect, useState } from "react"
import type { Store } from "@livestore/livestore"
import { tables, type schema } from "./schema"

/**
 * True iff any project has local writes not yet confirmed synced
 * (`event_queue` has rows in ANY status — `pending`/`flushing`/stuck
 * `failed` all count, same reasoning as `getOfflineQueueDepth` in
 * download.ts) or a download is still in flight (an interrupted download
 * leaves a partial local copy, not just a redownload-later inconvenience).
 */
export function hasUnsyncedOfflineWork(store: Store<typeof schema>): boolean {
  if (store.query(tables.eventQueue.select()).length > 0) return true
  return store.query(tables.offlineProjects.select().where({ status: "downloading" })).length > 0
}

/**
 * Installs a `beforeunload` warning while `hasUnsyncedOfflineWork(store)` is
 * true. A no-op when `store` is null (outside Tauri, or before the offline
 * store finishes booting).
 */
export function useUnsyncedOfflineWorkGuard(store: Store<typeof schema> | null): void {
  const [unsynced, setUnsynced] = useState(() => (store ? hasUnsyncedOfflineWork(store) : false))

  useEffect(() => {
    if (!store) {
      setUnsynced(false)
      return
    }
    const recheck = () => setUnsynced(hasUnsyncedOfflineWork(store))
    recheck()
    const unsubQueue = store.subscribe(tables.eventQueue.select(), recheck)
    const unsubProjects = store.subscribe(tables.offlineProjects.select(), recheck)
    return () => {
      unsubQueue()
      unsubProjects()
    }
  }, [store])

  useEffect(() => {
    if (!unsynced) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ""
    }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [unsynced])
}
