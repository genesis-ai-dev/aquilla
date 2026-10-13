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
        onStaleChange(got.structureStale)
      })
      .catch(async () => {
        // The columns alone still let the mapping show titles and offer them.
        if (orgId == null) {
          if (alive) setStructure(null)
          return
        }
        try {
          const got = await fetchMondayBoardStructure(jwt, orgId, boardId)
          if (alive) setStructure(got)
        } catch {
          if (alive) setStructure(null)
        }
      })
    return () => {
      alive = false
    }
  }, [jwt, active, projectId, orgId, boardId, nonce, onStaleChange])

  /** "Not needed": stop asking about these columns. */
  const dismiss = useCallback(
    async (columnIds: string[]) => {
      if (!jwt) return
      const got = await dismissMondayBoardChanges(jwt, projectId, columnIds)
      setStructure(got.structure)
      setNewColumns(got.newColumns)
      onStaleChange(got.structureStale)
    },
    [jwt, projectId, onStaleChange],
  )

  // With no board (or no right to read it) there is nothing to show; what an
  // earlier board returned is ignored rather than cleared.
  return active
    ? { structure, newColumns, refresh, dismiss }
    : { structure: null, newColumns: NO_COLUMNS, refresh, dismiss }
}
