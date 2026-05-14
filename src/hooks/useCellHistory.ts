// This file currently mixes two concerns:
//   1. Y.Doc write helpers (appendCellHistory, validateCell, etc.) — kept
//      verbatim for Phase 2b. They will be replaced with outbox-emitting
//      counterparts in Phase 2c.
//   2. A read-side React hook `useCellHistory` (Phase 2b addition) that
//      fetches the event chain for one cell off the sync-worker projection.
//
// `useCellEditHistory` covers an overlapping concern with a different
// projection (cell.commit only, mapped to the legacy CellHistoryEntry
// shape used by HistoryDrawer). `useCellHistory` returns the raw event
// chain — every kind, parent pointer, payload — so a richer history view
// (or audit log) can render it directly. Phase 2c collapses the two; in
// 2b they coexist with a clear division of labor.

import { useCallback, useEffect, useRef, useState } from "react"
import * as Y from "yjs"
import type { CellHistoryEntry } from "@/lib/parsers/types"
import { fetchCellHistory } from "@/lib/sync/history-read"
import type { CellHistoryEvent } from "@/lib/sync/history-read-types"
import { getPlainText, setPlainText } from "@/lib/richtext/translated-xml"
import { toggleCellValidation as toggleCellEditsValidation } from "@/lib/codex-editor/edits/toggle-cell-validation"
import { commitCellEdit } from "@/lib/codex-editor/edits/commit-cell-edit"
import {
  enqueueCellCommitAfterValueEdit,
} from "@/lib/sync/cqrs-bridge"

// ──────────────────────────────────────────────────────────────────────────
// Phase 2b: read-side hook. Fetches event chain for a (projectId, fileId,
// cellId) tuple. Returns the raw events; map to CellHistoryEntry per
// caller. HistoryDrawer continues to consume useCellEditHistory's narrower
// projection.
// ──────────────────────────────────────────────────────────────────────────

export interface UseCellHistoryOptions {
  projectId: string | null
  fileId: string | null
  cellId: string | null
  /** Server clamps to [1, 200]; default 50. */
  limit?: number
  getToken?: (fileId: string) => Promise<string | null>
  /** Disable the fetch (e.g. before identity loads / cell sheet closed). */
  enabled?: boolean
}

export interface UseCellHistoryResult {
  events: CellHistoryEvent[]
  revalidate: () => void
  isLoading: boolean
  isError: boolean
}

/**
 * Fetches the event chain for one cell on mount, on focus, and on
 * `revalidate()`. Same race-guarded refetch pattern as `useCells`
 * (generation counter ignores stale responses after a tuple change).
 */
export function useCellHistory(opts: UseCellHistoryOptions): UseCellHistoryResult {
  const {
    projectId,
    fileId,
    cellId,
    limit,
    getToken,
    enabled = true,
  } = opts

  const [events, setEvents] = useState<CellHistoryEvent[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isError, setIsError] = useState(false)

  const projectRef = useRef(projectId)
  const fileRef = useRef(fileId)
  const cellRef = useRef(cellId)
  const limitRef = useRef(limit)
  const tokenFetcherRef = useRef(getToken)
  const enabledRef = useRef(enabled)
  const generationRef = useRef(0)

  projectRef.current = projectId
  fileRef.current = fileId
  cellRef.current = cellId
  limitRef.current = limit
  tokenFetcherRef.current = getToken
  enabledRef.current = enabled

  const doFetch = useCallback(async () => {
    const pid = projectRef.current
    const fid = fileRef.current
    const cid = cellRef.current
    if (!enabledRef.current || !pid || !fid || !cid) {
      setEvents([])
      setIsLoading(false)
      setIsError(false)
      return
    }
    const gen = ++generationRef.current
    setIsLoading(true)
    setIsError(false)
    try {
      const fetchToken = tokenFetcherRef.current
      const token = fetchToken ? await fetchToken(fid) : null
      if (!token) {
        if (generationRef.current !== gen) return
        setIsError(true)
        setIsLoading(false)
        return
      }
      const rows = await fetchCellHistory(pid, fid, cid, token, { limit: limitRef.current })
      if (generationRef.current !== gen) return
      setEvents(rows)
      setIsLoading(false)
    } catch (err) {
      if (generationRef.current !== gen) return
      console.warn("[useCellHistory] fetch failed:", err)
      setIsError(true)
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void doFetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, fileId, cellId, enabled, limit])

  useEffect(() => {
    if (typeof window === "undefined") return
    function onFocus() { void doFetch() }
    function onVis() {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void doFetch()
      }
    }
    window.addEventListener("focus", onFocus)
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVis)
    }
    return () => {
      window.removeEventListener("focus", onFocus)
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVis)
      }
    }
  }, [doFetch])

  const revalidate = useCallback(() => {
    void doFetch()
  }, [doFetch])

  return { events, revalidate, isLoading, isError }
}

/**
 * Map a raw event chain to the legacy `CellHistoryEntry` shape used by
 * HistoryDrawer. Used for callers that don't want to migrate their
 * rendering; pulls `value` from the payload, `author` and `serverTs`
 * from the envelope. Anything the events log doesn't carry (validated
 * flag, examples) comes back defaulted.
 */
export function eventsToHistoryEntries(events: CellHistoryEvent[]): CellHistoryEntry[] {
  // Server returns newest-first; HistoryDrawer's groupHistory() expects
  // oldest-first — reverse here so consumers don't have to.
  const entries: CellHistoryEntry[] = []
  for (const e of [...events].reverse()) {
    const payload = e.payload as { value?: string } | null
    entries.push({
      timestamp: new Date(e.serverTs).toISOString(),
      value: payload?.value ?? "",
      source: "human",
      author: e.author,
      validated: false,
    })
  }
  return entries
}

// ──────────────────────────────────────────────────────────────────────────
// Y.Doc write helpers (Phase 2b: untouched; Phase 2c rewrites these to emit
// outbox events). Kept here for API compatibility with EditorTable et al.
// ──────────────────────────────────────────────────────────────────────────


// Cap on per-cell `history` Y.Array length. Each entry duplicates the full
// `value` text plus author/timestamp metadata, so unbounded growth is the
// main reason a 15+ MB Y.Doc can hit the Cloudflare DO 128 MiB memory cap
// at runtime. The HistoryDrawer UI shows the most recent entries; older
// entries are mostly invisible. Mirror of HISTORY_CAP_PER_CELL in
// sync-worker/src/index.ts (server safety net).
const HISTORY_CAP_PER_CELL = 100

/**
 * Trim the head of a history Y.Array so its length is at most cap. Caller
 * is responsible for wrapping in doc.transact().
 */
function trimHistoryToCap(arr: Y.Array<CellHistoryEntry>, cap: number): void {
  if (arr.length <= cap) return
  arr.delete(0, arr.length - cap)
}

export function appendCellHistory(
  doc: Y.Doc,
  cellId: string,
  entry: Omit<CellHistoryEntry, "timestamp">,
  opts?: { skipCqrs?: boolean },
): void {
  const cellsMap = doc.getMap("cells")
  const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) return

  doc.transact(() => {
    const frag = cell.get("translatedXml") as Y.XmlFragment | undefined
    if (frag) {
      setPlainText(frag, entry.value)
    } else {
      // legacy fallback
      cell.set("translated", entry.value)
    }
    let historyArr = cell.get("history") as Y.Array<CellHistoryEntry> | undefined
    if (!historyArr) {
      historyArr = new Y.Array<CellHistoryEntry>()
      cell.set("history", historyArr)
    }
    trimHistoryToCap(historyArr, HISTORY_CAP_PER_CELL - 1)
    historyArr.push([{ ...entry, timestamp: new Date().toISOString() }])
  })
  if (!opts?.skipCqrs) {
    enqueueCellCommitAfterValueEdit(doc, cellId)
  }
}

/**
 * Remove the last history entry if it's a placeholder LLM seed by the given
 * author (empty value, validated:false). Used by completion paths to clean up
 * the seed entry before recording the final translation. Without this collapse
 * the cell ends up with a phantom empty-LLM entry in its history view.
 */
export function dropLlmSeedHistory(
  doc: Y.Doc,
  cellId: string,
  llmAuthor: string
): void {
  const cellsMap = doc.getMap("cells")
  const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) return
  const historyArr = cell.get("history") as Y.Array<CellHistoryEntry> | undefined
  if (!historyArr || historyArr.length === 0) return
  const last = historyArr.get(historyArr.length - 1)
  if (
    last.source === "llm" &&
    last.author === llmAuthor &&
    !last.validated &&
    (last.value === "" || last.value === undefined)
  ) {
    doc.transact(() => historyArr.delete(historyArr.length - 1, 1))
  }
}

// Append a history entry WITHOUT modifying the fragment. Use this when the
// fragment was already updated by the TipTap editor — we just want to record
// the revision for audit without clobbering inline formatting via setPlainText.
export function recordHistoryEntry(
  doc: Y.Doc,
  cellId: string,
  entry: Omit<CellHistoryEntry, "timestamp">
): void {
  const cellsMap = doc.getMap("cells")
  const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) return

  doc.transact(() => {
    let historyArr = cell.get("history") as Y.Array<CellHistoryEntry> | undefined
    if (!historyArr) {
      historyArr = new Y.Array<CellHistoryEntry>()
      cell.set("history", historyArr)
    }
    trimHistoryToCap(historyArr, HISTORY_CAP_PER_CELL - 1)
    historyArr.push([{ ...entry, timestamp: new Date().toISOString() }])
  })
}

export function validateCell(
  doc: Y.Doc, cellId: string, username: string,
  /** See commit-cell-edit.ts for fileIdOverride rationale. */
  fileIdOverride?: string,
): void {
  const cellsMap = doc.getMap("cells")
  const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) return
  const frag = cell.get("translatedXml") as Y.XmlFragment | undefined
  const translated = frag ? getPlainText(frag) : ((cell.get("translated") as string) || "")
  if (!translated.trim()) return
  // Two-step: ensure a value-edit exists in the ledger, then explicitly
  // validate it. commitCellEdit no longer auto-validates — validation is
  // strictly an explicit, button-triggered action.
  commitCellEdit(doc, cellId, username, ["value"], translated, "human", fileIdOverride)
  toggleCellEditsValidation(doc, cellId, username, true, fileIdOverride)
  // Keep the history log entry for TipTap/audit; this is a deliberate
  // validation, so validated:true here mirrors the cell.edits state.
  appendCellHistory(doc, cellId, { value: translated, source: "human", author: username, validated: true }, { skipCqrs: true })
}

/**
 * Explicit validation toggle (not tied to a content commit). Delegates to
 * the Yjs-native cell.edits implementation; no more __source mutation.
 *
 * Imported cells (legacy git projects, fresh .codex notebooks) often arrive
 * with translated content but no `metadata.edits` history — there's nothing
 * for the underlying toggler to attach a validator to, so it would silently
 * no-op and leave the user wondering why "Validate" did nothing. When that
 * happens we seed a value-edit from the current text, which makes the cell
 * a first-class validatable record going forward.
 */
export function toggleCellValidation(
  doc: Y.Doc, cellId: string, username: string, validate: boolean,
  /** See commit-cell-edit.ts for fileIdOverride rationale. */
  fileIdOverride?: string,
): void {
  if (validate) {
    const cellsMap = doc.getMap("cells")
    const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
    if (cell) {
      const arr = cell.get("edits") as Y.Array<Y.Map<unknown>> | undefined
      const hasValueEdit = arr ? arrayHasValueEdit(arr) : false
      if (!hasValueEdit) {
        // Seed a value-edit from the current translated text and validate
        // in one shot. validateCell handles the empty-text guard.
        validateCell(doc, cellId, username, fileIdOverride)
        return
      }
    }
  }
  toggleCellEditsValidation(doc, cellId, username, validate, fileIdOverride)
}

function arrayHasValueEdit(arr: Y.Array<Y.Map<unknown>>): boolean {
  for (let i = 0; i < arr.length; i++) {
    const entry = arr.get(i)
    const editMapArr = entry.get("editMap") as Y.Array<string> | undefined
    if (editMapArr?.get(0) === "value") return true
  }
  return false
}

export function setCellBacktranslation(
  doc: Y.Doc,
  cellId: string,
  backtranslation: string,
  forText: string
): void {
  const cellsMap = doc.getMap("cells")
  const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) return

  doc.transact(() => {
    cell.set("backtranslation", backtranslation)
    cell.set("backtranslationUpdatedAt", new Date().toISOString())
    cell.set("backtranslationForText", forText)
  })
}
