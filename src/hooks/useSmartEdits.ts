// Smart edits in the editor (flag: `smartEdits`, src/lib/features/flags.ts).
//
// EditorTable owns one SmartEditStore and asks for suggestions a PASSAGE at a
// time — the active cell and its neighbours — so the server sees the whole
// passage at once (one Jev call for all of it, context for every cell) and a
// translator moving cell to cell inside it costs nothing more. Rows read their
// own slice through context, so no per-row prop threads through MemoizedRow.

import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import { readAtVersion } from "./useActiveCellStore"
import { useFrontierSession } from "./useFrontierSession"
import {
  fetchSmartEdits,
  sendSmartEditFeedback,
  type SmartEditPassageCell,
  type SmartEditSuggestion,
} from "@/lib/smart-edits/client"
import { SmartEditStore } from "@/lib/smart-edits/store"

/** Cells either side of the active one sent as its passage. */
export const PASSAGE_RADIUS = 10
const DEBOUNCE_MS = 400

export interface SmartEditsContextValue {
  store: SmartEditStore
  feedback: (s: SmartEditSuggestion, action: "accept" | "dismiss") => void
}

const SmartEditsContext = createContext<SmartEditsContextValue | null>(null)
export const SmartEditsProvider = SmartEditsContext.Provider

/** The window of cell ids around `activeId`, in display order. */
export function passageWindow(cellIds: readonly string[], activeId: string, radius = PASSAGE_RADIUS): string[] {
  const i = cellIds.indexOf(activeId)
  if (i < 0) return []
  return cellIds.slice(Math.max(0, i - radius), i + radius + 1)
}

export function useSmartEditsPassage(options: {
  enabled: boolean
  projectId: string
  lane: string
  cellIds: readonly string[]
  activeCellId: string | null
  /** Text of the active cell — a commit there refreshes the passage. */
  activeText: string | undefined
  getCell: (cellId: string) => SmartEditPassageCell | null
}): SmartEditsContextValue | null {
  const { enabled, projectId, lane, cellIds, activeCellId, activeText } = options
  const { session } = useFrontierSession()
  const token = session?.jwt
  const store = useMemo(() => new SmartEditStore(), [])
  const getCellRef = useRef(options.getCell)
  useEffect(() => {
    getCellRef.current = options.getCell
  })

  useEffect(() => {
    if (!enabled || !token || !activeCellId) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      const cells = passageWindow(cellIds, activeCellId)
        .map((id) => getCellRef.current(id))
        .filter((c): c is SmartEditPassageCell => c !== null && c.target.trim().length > 0)
      if (cells.length === 0 || store.isFresh(cells)) return
      void fetchSmartEdits({ projectId, lane, cells }, token, controller.signal).then((suggestions) => {
        if (!controller.signal.aborted) store.setPassage(cells, suggestions)
      })
    }, DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [enabled, token, projectId, lane, cellIds, activeCellId, activeText, store])

  return useMemo(() => {
    if (!enabled || !token) return null
    return {
      store,
      feedback: (s, action) => {
        store.hide(s)
        sendSmartEditFeedback({ projectId, lane, suggestion: s, action }, token)
      },
    }
  }, [enabled, token, store, projectId, lane])
}

const NO_SUGGESTIONS: SmartEditSuggestion[] = []
const noopSubscribe = () => () => {}
const zero = () => 0

/** Suggestions for one row, valid for exactly `text`. */
export function useSmartEditsForCell(cellId: string, text: string): {
  suggestions: SmartEditSuggestion[]
  feedback: SmartEditsContextValue["feedback"] | undefined
} {
  const ctx = useContext(SmartEditsContext)
  const store = ctx?.store
  const version = useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.getVersion ?? zero, zero)
  const suggestions = useMemo(
    () => (store ? readAtVersion(version, () => store.forCell(cellId, text)) : NO_SUGGESTIONS),
    [store, version, cellId, text],
  )
  return { suggestions: suggestions.length ? suggestions : NO_SUGGESTIONS, feedback: ctx?.feedback }
}
