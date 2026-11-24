// Smart edits in the editor (project-wide and on by default: `isSmartEditsEnabled`,
// src/lib/features/flags.ts).
//
// EditorTable owns one SmartEditStore and asks for suggestions a PASSAGE at a
// time — the active cell and its neighbours — so the server has the passage as
// context. It asks only about the cells it has no answer for: a translator
// moving cell to cell inside a passage, or committing one cell of it, costs one
// cell's worth of work, not the passage again. Rows read their own slice
// through context, so no per-row prop threads through MemoizedRow.

import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { useFrontierSession } from "./useFrontierSession"
import {
  fetchSmartEdits,
  requestLlmEdits,
  sendSmartEditFeedback,
  type SmartEditPassageCell,
  type SmartEditSuggestion,
} from "@/lib/smart-edits/client"
import { NO_SUGGESTIONS, SmartEditStore } from "@/lib/smart-edits/store"
import { fetchHarmonizerSuggestions } from "@/lib/harmonizer/client"

/** Cells either side of the active one sent as its passage. */
export const PASSAGE_RADIUS = 10
const DEBOUNCE_MS = 400

/** Result of an on-request LLM ask. `reveal` puts the suggestions on screen —
 *  the caller runs it once its loading animation has finished. */
export type AskLlmResult =
  | { ok: true; count: number; reveal: () => void }
  | { ok: false; reason: "allowance" | "failed" }

export interface SmartEditsContextValue {
  store: SmartEditStore
  feedback: (s: SmartEditSuggestion, action: "accept" | "dismiss") => void
  /** Present only when the opt-in `smartEditsLlm` flag is on. */
  askLlm?: (cellId: string, text: string) => Promise<AskLlmResult>
}

/** Cells either side sent with an LLM ask, for context. */
const LLM_NEIGHBOR_RADIUS = 3

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
  llmEnabled: boolean
  /** AQU-1657: cross-cell harmonizer checks (flag `harmonizer`). Its
   *  suggestions share this store, underline and popover. */
  harmonizerEnabled?: boolean
  projectId: string
  lane: string
  cellIds: readonly string[]
  activeCellId: string | null
  /** Text of the active cell — a commit there refreshes the passage. */
  activeText: string | undefined
  getCell: (cellId: string) => SmartEditPassageCell | null
}): SmartEditsContextValue | null {
  const { enabled, llmEnabled, projectId, lane, cellIds, activeCellId, activeText } = options
  const harmonizerEnabled = options.harmonizerEnabled ?? false
  const { session } = useFrontierSession()
  const token = session?.jwt
  const [store] = useState(() => new SmartEditStore())
  const getCellRef = useRef(options.getCell)
  useEffect(() => {
    getCellRef.current = options.getCell
  })

  // A request outlives the cell move that follows it — its answer is stored
  // against the text it was asked about, so a late one is still right, and
  // dropping it would only make the server do the work twice. It does not
  // outlive the project, lane or session it was made for.
  const scopeRef = useRef<AbortController | null>(null)
  useEffect(() => {
    const scope = new AbortController()
    scopeRef.current = scope
    return () => scope.abort()
  }, [token, projectId, lane])

  useEffect(() => {
    if (!enabled || !token || !activeCellId) return
    const timer = window.setTimeout(() => {
      const signal = scopeRef.current?.signal
      if (!signal || signal.aborted) return
      const cells = passageWindow(cellIds, activeCellId)
        .map((id) => getCellRef.current(id))
        .filter((c): c is SmartEditPassageCell => c !== null && c.target.trim().length > 0)
      const stale = store.claim(cells)
      if (stale.length === 0) return
      // The harmonizer checks across cells, so with it on the whole passage is
      // asked about again. One passage, both sources, one store write: two
      // writes would let the second wipe the first's suggestions.
      const asked = harmonizerEnabled ? cells : stale
      void Promise.all([
        fetchSmartEdits(
          { projectId, lane, cells, ...(harmonizerEnabled ? {} : { only: asked.map((c) => c.cellId) }) },
          token,
          signal,
        ),
        harmonizerEnabled ? fetchHarmonizerSuggestions({ projectId, lane, cells }, token, signal) : Promise.resolve([]),
      ]).then(
        ([edits, harmonies]) => store.settle(asked, signal.aborted ? undefined : [...edits, ...harmonies]),
        () => store.settle(asked),
      )
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [enabled, harmonizerEnabled, token, projectId, lane, cellIds, activeCellId, activeText, store])

  const cellIdsRef = useRef(cellIds)
  useEffect(() => {
    cellIdsRef.current = cellIds
  })

  return useMemo(() => {
    if (!enabled || !token) return null
    const askLlm = llmEnabled
      ? async (cellId: string, text: string): Promise<AskLlmResult> => {
          const cell = getCellRef.current(cellId)
          if (!cell) return { ok: false, reason: "failed" }
          const neighbors = passageWindow(cellIdsRef.current, cellId, LLM_NEIGHBOR_RADIUS)
            .filter((id) => id !== cellId)
            .map((id) => getCellRef.current(id))
            .filter((c): c is SmartEditPassageCell => c !== null)
            .map((c) => ({ source: c.source, target: c.target }))
          const result = await requestLlmEdits(
            { projectId, lane, fileId: cell.fileId, cellId, source: cell.source, target: text, neighbors },
            token,
          )
          if (!result.ok) return result
          return { ok: true, count: result.suggestions.length, reveal: () => store.addForCell(cellId, text, result.suggestions) }
        }
      : undefined
    return {
      store,
      feedback: (s, action) => {
        store.hide(s)
        sendSmartEditFeedback({ projectId, lane, suggestion: s, action }, token)
      },
      askLlm,
    }
  }, [enabled, llmEnabled, token, store, projectId, lane])
}

const noopSubscribe = () => () => {}

/** Suggestions for one row, valid for exactly `text`. The snapshot is the
 *  store's own array for that cell, so a row re-renders only when its own
 *  suggestions change. */
export function useSmartEditsForCell(cellId: string, text: string): {
  suggestions: SmartEditSuggestion[]
  feedback: SmartEditsContextValue["feedback"] | undefined
  askLlm: (() => Promise<AskLlmResult>) | undefined
} {
  const ctx = useContext(SmartEditsContext)
  const store = ctx?.store
  const suggestions = useSyncExternalStore(store?.subscribe ?? noopSubscribe, () =>
    store ? store.forCell(cellId, text) : NO_SUGGESTIONS,
  )
  const ask = ctx?.askLlm
  const askLlm = useMemo(() => (ask ? () => ask(cellId, text) : undefined), [ask, cellId, text])
  return { suggestions, feedback: ctx?.feedback, askLlm }
}
