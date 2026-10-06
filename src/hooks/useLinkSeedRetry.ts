// AQU-1544 — read and retry a project's failed first mirror sync.
//
// `useLinkSeedFailed` is the read side of `link-seed-status`: true while this
// session knows the project's link was saved but its files never arrived.
// `useLinkSeedRetry` is the "Try again" behind every surface that says so (the
// link flow's notice, the workspace/overview banner), kept in one place so the
// three entry points cannot drift on what a retry does or what counts as it
// having worked.

import { useCallback, useState, useSyncExternalStore } from "react"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { triggerLinkSync } from "@/lib/sync/archive"
import {
  clearLinkSeedFailed,
  isLinkSeedFailed,
  subscribeLinkSeedStatus,
} from "@/lib/sync/link-seed-status"
import { announceProjectRecordChanged } from "@/lib/sync/project-record-changed"

export function useLinkSeedFailed(projectId: string | null | undefined): boolean {
  return useSyncExternalStore(subscribeLinkSeedStatus, () =>
    projectId ? isLinkSeedFailed(projectId) : false,
  )
}

export interface LinkSeedRetry {
  /** A retry is in flight. */
  retrying: boolean
  /** The most recent retry failed too — the notice says so rather than sitting
   *  unchanged, which would read as the button having done nothing. */
  retryFailed: boolean
  retry: () => Promise<void>
}

/**
 * Re-run the first mirror sync for `projectId`. On success the session's
 * failed mark is cleared and `onSynced` fires so the host can pull the files
 * that just arrived; on failure nothing about the project changes — the link
 * stays saved and the retry stays available.
 */
export function useLinkSeedRetry(projectId: string, onSynced: () => void): LinkSeedRetry {
  const { session } = useFrontierSession()
  const jwt = session?.jwt
  const [retrying, setRetrying] = useState(false)
  const [retryFailed, setRetryFailed] = useState(false)

  const retry = useCallback(async () => {
    if (!jwt || retrying) return
    setRetrying(true)
    try {
      // Never throws: `triggerLinkSync` folds every failure into `false`.
      const ok = await triggerLinkSync(jwt, projectId)
      if (ok) {
        clearLinkSeedFailed(projectId)
        // AQU-1570: every page showing the project, not only this host —
        // the retry may be pressed inside Project Settings, over the page
        // whose file list the files just arrived in.
        announceProjectRecordChanged(projectId)
        setRetryFailed(false)
        onSynced()
      } else {
        setRetryFailed(true)
      }
    } finally {
      setRetrying(false)
    }
  }, [jwt, retrying, projectId, onSynced])

  return { retrying, retryFailed, retry }
}
