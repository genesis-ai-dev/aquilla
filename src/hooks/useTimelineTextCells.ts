import { useCallback, useEffect, useRef, useState } from "react"
import { buildCellData, type CellData } from "./useCells"
import { fetchAllFileCells } from "@/lib/sync/cells-read"
import { subscribeAppliedEvents } from "@/lib/sync/outbox-flush"
import { subscribeWindowRegainedFocus } from "@/lib/sync/window-focus-revalidate"

interface Args {
  projectId: string | null
  fileIds: readonly string[]
  getToken: (fileId: string) => Promise<string | null>
  enabled?: boolean
}
interface State {
  scope: string
  cellsByFile: Record<string, CellData[]>
  errors: Record<string, Error>
  isLoading: boolean
}
const EMPTY_CELLS: Record<string, CellData[]> = {}
const EMPTY_ERRORS: Record<string, Error> = {}

/** Caption files have independent identities. Guard asynchronous reads by
 * scope so changing timelines cannot display the previous file's captions.
 * Outbox receipts, peer events, and focus recovery all converge on the same
 * authoritative read; callers never copy parent cells into an empty track.
 */
export function useTimelineTextCells({ projectId, fileIds, getToken, enabled = true }: Args) {
  const idsKey = JSON.stringify(enabled ? [...new Set(fileIds)].sort() : [])
  const scope = JSON.stringify([projectId, idsKey])
  const tokenRef = useRef(getToken)
  tokenRef.current = getToken
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<State>({
    scope, cellsByFile: {}, errors: {}, isLoading: false,
  })

  const refresh = useCallback((fileId?: string) => {
    const ids = JSON.parse(idsKey) as string[]
    if (projectId && ids.length && (fileId === undefined || ids.includes(fileId))) {
      setRevision(value => value + 1)
    }
  }, [projectId, idsKey])

  // AQU-2655: the scope whose every file has an answer on screen. A read
  // behind one (a focus return, an applied event) is a revalidation: the
  // captions stay as they are, `isLoading` stays false, and the new answer
  // lands in one update once every file is back — not a spinner and N
  // partial updates each time the window regains focus.
  const loadedScopeRef = useRef<string | null>(null)

  useEffect(() => {
    const ids = JSON.parse(idsKey) as string[]
    if (!projectId || !ids.length) {
      loadedScopeRef.current = null
      setState({ scope, cellsByFile: {}, errors: {}, isLoading: false })
      return
    }
    let cancelled = false
    const revalidating = loadedScopeRef.current === scope
    const fresh: Record<string, CellData[]> = {}
    const freshErrors: Record<string, Error> = {}
    if (!revalidating) {
      setState(previous => ({ scope,
        cellsByFile: previous.scope === scope ? previous.cellsByFile
          : Object.fromEntries(ids.map(id => [id, []])),
        errors: {}, isLoading: true,
      }))
    }
    const update = (fileId: string, cells: CellData[], error?: Error) => {
      if (cancelled || scopeRef.current !== scope) return
      if (revalidating) {
        fresh[fileId] = cells
        if (error) freshErrors[fileId] = error
        return
      }
      setState(previous => ({ ...previous,
        cellsByFile: { ...previous.cellsByFile, [fileId]: cells },
        errors: error ? { ...previous.errors, [fileId]: error } : previous.errors,
      }))
    }
    let cursor = 0
    const worker = async () => {
      while (!cancelled && cursor < ids.length) {
        const fileId = ids[cursor++]
        try {
          const token = await tokenRef.current(fileId)
          if (!token) throw new Error("Couldn't get a read token for these captions.")
          const rows = await fetchAllFileCells(projectId, fileId, token, "source")
          update(fileId, rows.map(row =>
            buildCellData(row.cellId, row, undefined, fileId, "local", 1, undefined)))
        } catch (cause) {
          update(fileId, [], cause instanceof Error ? cause : new Error(String(cause)))
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker))
      .then(() => {
        if (cancelled || scopeRef.current !== scope) return
        loadedScopeRef.current = scope
        if (revalidating) {
          setState(previous => ({ ...previous,
            cellsByFile: { ...previous.cellsByFile, ...fresh }, errors: freshErrors,
          }))
          return
        }
        setState(previous => ({ ...previous, isLoading: false }))
      })
    return () => { cancelled = true }
  }, [projectId, idsKey, scope, revision])

  useEffect(() => subscribeAppliedEvents(frames => {
    if (frames.some(frame => frame.project === projectId && frame.file
      && (JSON.parse(idsKey) as string[]).includes(frame.file))) refresh()
  }), [projectId, idsKey, refresh])
  useEffect(() => subscribeWindowRegainedFocus(() => refresh()), [refresh])

  const patchTiming = useCallback((fileId: string, cellId: string, start: number, end: number) => {
    setState(previous => previous.scope !== scope ? previous : {
      ...previous, cellsByFile: { ...previous.cellsByFile,
        [fileId]: (previous.cellsByFile[fileId] ?? []).map(cell => cell.id === cellId
          ? { ...cell, startTime: start, endTime: end } : cell),
      },
    })
  }, [scope])

  return {
    cellsByFile: state.scope === scope ? state.cellsByFile : EMPTY_CELLS,
    errors: state.scope === scope ? state.errors : EMPTY_ERRORS,
    isLoading: state.scope === scope ? state.isLoading : Boolean(projectId && enabled && fileIds.length),
    refresh, patchTiming,
  }
}
