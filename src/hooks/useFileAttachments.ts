/**
 * useFileAttachments — every live attachment in the open file (AQU-777).
 *
 * Reads over HTTP from sync-worker (AD-3 thin client), writes through the
 * outbox. Scoped to a FILE rather than a cell because both consumers want the
 * same set: the drawer lists the whole file grouped by cell, and each cell's
 * link row is one group out of it. One request per file beats one per visible
 * row, and it means opening the drawer shows a list that is already loaded.
 *
 * Optimistic writes follow useComments: a locally-added record is merged into
 * the list until the server's copy arrives, and a locally-removed one is hidden
 * until the server agrees. Without that, an attach would flash the link in and
 * out between the emit and the outbox flush.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { fetchAttachmentsForFile } from "@/lib/sync/cell-attachments-read"
import type { CellAttachmentRecord } from "@/lib/sync/cell-attachments-read-types"

export type { CellAttachmentRecord }

export interface UseFileAttachmentsOptions {
  projectId: string | null
  fileId: string | null
  /** Token fetcher — same signature as useComments'. Any file-scoped
   *  sync-token for the project works; the read route checks only projectId. */
  getToken?: (fileId: string) => Promise<string | null>
  /**
   * Auth-readiness signal (AQU-640's pattern). While false the initial load
   * waits instead of firing a fetch that would bail on a null token and never
   * retry. Omit to always auto-load.
   */
  tokenReady?: boolean
}

export interface UseFileAttachmentsApi {
  /** Live attachments in (cellId, createdAt, attachmentId) order. */
  attachments: CellAttachmentRecord[]
  /**
   * The same rows indexed by cell id, each group still in list order.
   *
   * ONE map for the file rather than a per-cell selector function: the editor's
   * rows are React.memo'd, and a selector returning a fresh array per call
   * would fail their shallow compare for every rendered row on every attach.
   * The map's identity changes only when the attachments actually change.
   */
  byCell: ReadonlyMap<string, readonly CellAttachmentRecord[]>
  isLoading: boolean
  isError: boolean
  /** True when the file has more attachments than the worker returns. */
  truncated: boolean
  refresh: () => Promise<void>
  /** Show a just-attached record before the flush lands. */
  addOptimistic: (record: CellAttachmentRecord) => void
  /** Hide a just-removed record before the flush lands. */
  removeOptimistic: (attachmentId: string) => void
}

/** Stable identity for "nothing loaded", so an idle hook doesn't churn. */
const EMPTY_ROWS: readonly CellAttachmentRecord[] = []

function byCellThenCreated(a: CellAttachmentRecord, b: CellAttachmentRecord): number {
  return (
    a.cellId.localeCompare(b.cellId) ||
    a.createdAt - b.createdAt ||
    a.attachmentId.localeCompare(b.attachmentId)
  )
}

export function useFileAttachments(
  opts: UseFileAttachmentsOptions,
): UseFileAttachmentsApi {
  const { projectId, fileId, getToken, tokenReady } = opts

  // Server truth and local intent are held SEPARATELY, and the visible list is
  // derived from both below. Merging them into one state array is what makes
  // an optimistic list drift: a refresh either clobbers pending local intent
  // or has to reconstruct which rows were local, and gets it wrong the first
  // time two attaches race one flush.
  //
  // All of it is STAMPED WITH THE FILE it belongs to, and the derivation below
  // discards a stamp that doesn't match the open file. That is what keeps one
  // file's attachments out of another's list — the leak the issue's own test
  // checklist calls out — and it does it without an effect that resets state
  // on every file change: such an effect necessarily runs AFTER the first
  // render with the new fileId, so the previous file's rows would paint for
  // one frame under the new file's name.
  const [loaded, setLoaded] = useState<{
    fileId: string | null
    rows: CellAttachmentRecord[]
    truncated: boolean
  }>({ fileId: null, rows: [], truncated: false })
  const [pendingAdds, setPendingAdds] = useState<CellAttachmentRecord[]>([])
  const [pendingRemovals, setPendingRemovals] = useState<readonly string[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isError, setIsError] = useState(false)

  // Only what was loaded for the file that is actually open counts.
  const forThisFile = loaded.fileId !== null && loaded.fileId === fileId
  const serverRows = forThisFile ? loaded.rows : EMPTY_ROWS
  const truncated = forThisFile ? loaded.truncated : false

  // Latest props in refs so refresh() doesn't close over stale values.
  const projectRef = useRef(projectId)
  const fileRef = useRef(fileId)
  const tokenFetcherRef = useRef(getToken)
  useEffect(() => {
    projectRef.current = projectId
    fileRef.current = fileId
    tokenFetcherRef.current = getToken
  }, [projectId, fileId, getToken])

  // Bumped per refresh(); a superseded response is dropped.
  const fetchGenRef = useRef(0)

  const refresh = useCallback(async () => {
    const pid = projectRef.current
    const fid = fileRef.current
    const fetchToken = tokenFetcherRef.current
    if (!pid || !fid || !fetchToken) {
      // Nothing to load, and nothing to clear: the stamped state below is
      // already invisible whenever the open file isn't the one it was loaded
      // for — including when there is no open file at all.
      return
    }
    const gen = ++fetchGenRef.current
    const isCurrent = () => gen === fetchGenRef.current

    setIsLoading(true)
    setIsError(false)
    try {
      const jwt = await fetchToken(fid)
      if (!jwt) {
        if (isCurrent()) setIsLoading(false)
        return
      }
      const { attachments: rows, truncated: wasTruncated } =
        await fetchAttachmentsForFile(pid, fid, jwt)
      if (!isCurrent()) return
      setLoaded({ fileId: fid, rows, truncated: wasTruncated })
      // Settle local intent against what the server now says. An add it
      // echoes, and a removal it has applied, are both done — dropping them
      // here is what stops the pending sets growing for the life of the
      // session and filtering ids that no longer exist.
      const serverIds = new Set(rows.map((r) => r.attachmentId))
      setPendingAdds((prev) =>
        prev.filter((r) => r.fileId === fid && !serverIds.has(r.attachmentId)),
      )
      setPendingRemovals((prev) => prev.filter((id) => serverIds.has(id)))
    } catch {
      if (isCurrent()) setIsError(true)
    } finally {
      if (isCurrent()) setIsLoading(false)
    }
  }, [])

  // Auto-load on project/file change. Nothing is reset here — the stamped
  // state above means the previous file's rows are already invisible by the
  // time this runs, and a pending add is filtered by its own fileId.
  useEffect(() => {
    if (!projectId || !fileId) return
    if (tokenReady === false) return
    void refresh()
  }, [projectId, fileId, tokenReady, refresh])

  const addOptimistic = useCallback((record: CellAttachmentRecord) => {
    setPendingRemovals((prev) => prev.filter((id) => id !== record.attachmentId))
    setPendingAdds((prev) =>
      prev.some((r) => r.attachmentId === record.attachmentId) ? prev : [...prev, record],
    )
  }, [])

  const removeOptimistic = useCallback((attachmentId: string) => {
    setPendingAdds((prev) => prev.filter((r) => r.attachmentId !== attachmentId))
    setPendingRemovals((prev) => (prev.includes(attachmentId) ? prev : [...prev, attachmentId]))
  }, [])

  const attachments = useMemo(() => {
    if (!fileId) return EMPTY_ROWS as CellAttachmentRecord[]
    const removed = new Set(pendingRemovals)
    const seen = new Set(serverRows.map((r) => r.attachmentId))
    const rows = [
      ...serverRows,
      // A pending add the server has already echoed would otherwise render
      // twice until the next refresh settles the set. The fileId check is the
      // same leak guard the stamped server rows get.
      ...pendingAdds.filter((r) => r.fileId === fileId && !seen.has(r.attachmentId)),
    ]
    return (removed.size ? rows.filter((r) => !removed.has(r.attachmentId)) : rows)
      .slice()
      .sort(byCellThenCreated)
  }, [fileId, serverRows, pendingAdds, pendingRemovals])

  const byCell = useMemo(() => {
    const index = new Map<string, CellAttachmentRecord[]>()
    for (const row of attachments) {
      const group = index.get(row.cellId)
      if (group) group.push(row)
      else index.set(row.cellId, [row])
    }
    return index as ReadonlyMap<string, readonly CellAttachmentRecord[]>
  }, [attachments])

  return {
    attachments,
    byCell,
    isLoading,
    isError,
    truncated,
    refresh,
    addOptimistic,
    removeOptimistic,
  }
}
