// The linked board's columns as they are now, and which of them are new since
// the link was saved (AQU-1770). Re-read on every `refresh()` — the settings
// page calls it whenever it reloads the link (opening, coming back to the tab,
// after a save), so a column added on Monday is always there to pick and the
// "Board structure changed" banner can name it. The server's answer is the
// authority on the banner: a new column that was deleted again clears it.

import { useCallback, useEffect, useState } from "react"
import {
  dismissMondayBoardChanges,
  fetchMondayBoardChanges,
  fetchMondayBoardStructure,
  type MondayBoardChanges,
  type MondayBoardStructure,
} from "@/lib/monday/api"

export type MondayNewColumn = MondayBoardChanges["newColumns"][number]

const NO_COLUMNS: MondayNewColumn[] = []

export function useMondayBoardChanges({
  jwt,
  projectId,
  orgId,
  boardId,
  enabled,
  onStaleChange,
}: {
  jwt: string | null
  projectId: string
  orgId: number | null | undefined
  /** The linked board, or "" when there is none. */
  boardId: string
  /** Board reads need a maintainer; others see the saved mapping only. */
  enabled: boolean
  /** The server's verdict on "Board structure changed", to mirror on the link. */
  onStaleChange: (stale: boolean) => void
}) {
  const [structure, setStructure] = useState<MondayBoardStructure | null>(null)
  const [newColumns, setNewColumns] = useState<MondayNewColumn[]>([])
  const [nonce, setNonce] = useState(0)
  // Which read last finished (or failed), and whether a dismiss is running.
  // While a read is out, what the box offers may be about to change (a new
  // column deleted again), so its buttons wait.
  const [settledNonce, setSettledNonce] = useState(-1)
  const [readFailed, setReadFailed] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  const active = Boolean(jwt && enabled && boardId)
  useEffect(() => {
    if (!jwt || !active) return
    let alive = true
    fetchMondayBoardChanges(jwt, projectId)
      .then((got) => {
        if (!alive) return
        setStructure(got.structure)
        setNewColumns(got.newColumns)
        setReadFailed(false)
        setSettledNonce(nonce)
        onStaleChange(got.structureStale)
      })
      .catch(async () => {
        // The columns alone still let the mapping show titles and offer them.
        if (orgId != null) {
          try {
            const got = await fetchMondayBoardStructure(jwt, orgId, boardId)
            if (alive) setStructure(got)
          } catch {
            // Keep whatever columns an earlier read gave.
          }
        }
        if (!alive) return
        setReadFailed(true)
        setSettledNonce(nonce)
      })
    return () => {
      alive = false
    }
  }, [jwt, active, projectId, orgId, boardId, nonce, onStaleChange])

  /** "Not needed": stop asking about these columns. */
  const dismiss = useCallback(
    async (columnIds: string[]) => {
      if (!jwt) return
      setDismissing(true)
      try {
        const got = await dismissMondayBoardChanges(jwt, projectId, columnIds)
        setStructure(got.structure)
        setNewColumns(got.newColumns)
        onStaleChange(got.structureStale)
      } finally {
        setDismissing(false)
      }
    },
    [jwt, projectId, onStaleChange],
  )

  // With no board (or no right to read it) there is nothing to show; what an
  // earlier board returned is ignored rather than cleared.
  const checking = active && (settledNonce !== nonce || dismissing)
  /** The first read hasn't answered yet: the mapping has no column titles to show. */
  const structureLoading = active && structure == null && !readFailed
  return active
    ? { structure, newColumns, refresh, dismiss, checking, structureLoading }
    : { structure: null, newColumns: NO_COLUMNS, refresh, dismiss, checking: false, structureLoading: false }
}
