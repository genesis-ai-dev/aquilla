import { useEffect, useLayoutEffect, useRef, useState } from "react"
import * as Y from "yjs"
import type { CellHistoryEntry, SourceLocation, CommentThread, CellTtsSettings } from "@/lib/parsers/types"
import type { CodexCellAttachment, WordTiming } from "@/lib/codex-editor/types"
import type { EditValidationSummary } from "@/lib/codex-editor/edits/types"
import { snapshotEntry, readLatestActiveValidators } from "@/lib/codex-editor/edits/yjs-helpers"
import { extractThreadsFromCell } from "./useComments"
import { getPlainText } from "@/lib/richtext/translated-xml"
import { perfLog, perfMark } from "@/lib/perf-log"
import type { CellAuditStats } from "./useCellsAuditStats"

export type ValidationStatus = "empty" | "none" | "others" | "self" | "full"

export interface CellData {
  id: string
  fileId: string
  cellLabel?: string
  original: string
  originalHtml?: string
  translated: string
  translatedXml?: Y.XmlFragment
  context: string
  group: string
  /** Optional section label for navigation/progress. USFM/ebible set this to "BOOK CHAPTER" (e.g. "GEN 1"). */
  section?: string
  /**
   * Scripture verse refs (e.g. ["LUK 1:1"]) attached to this cell. Drives sidebar section
   * derivation and future highlighting. Empty/undefined for non-scripture cells.
   */
  globalReferences?: string[]
  type: string
  status: "empty" | "unvalidated" | "validated"
  validationStatus: ValidationStatus
  activeValidators: string[]
  /** Read-only projection of cell.edits (value-editMap entries only, newest-last)
   *  used by the validation popover's history timeline. */
  validationHistory: EditValidationSummary[]
  history: CellHistoryEntry[]
  threads: CommentThread[]
  sourceLocation?: SourceLocation
  backtranslation?: string
  backtranslationUpdatedAt?: string
  backtranslationForText?: string
  attachments?: Record<string, CodexCellAttachment>
  selectedAudioId?: string
  selectedGeneratedVoiceAudioId?: string
  audioTimings?: Record<string, WordTiming[]>
  ttsSettings?: CellTtsSettings
  /** Cue start/end timestamps (seconds) from the cell's CodexData. Populated
   *  for subtitle-imported cells; used by the recording modal's duration bar. */
  startTime?: number
  endTime?: number
  waivers?: import("@/lib/parsers/types").RuleWaiver[]
}


function deriveStatus(translated: string, history: CellHistoryEntry[]): "empty" | "unvalidated" | "validated" {
  if (!translated || !translated.trim()) return "empty"
  if (history.length === 0) return "validated"
  return history[history.length - 1].validated ? "validated" : "unvalidated"
}

/** Classify a set of active validators into the UI's 5-state validation status.
 *  Shared by the D1-backed and Y.Doc-backed paths so both produce identical
 *  output for the same validator list. */
/** Stable empty map so the default-arg path doesn't trigger useLayoutEffect
 *  re-runs every render. */
const EMPTY_STATS: ReadonlyMap<string, CellAuditStats> = new Map()

function classifyValidators(
  active: string[],
  currentUsername: string,
  requiredValidations: number,
): ValidationStatus {
  if (active.length === 0) return "none"
  if (active.length >= requiredValidations) return "full"
  if (active.includes(currentUsername)) return "self"
  return "others"
}

function deriveValidationStatus(
  translated: string,
  cell: Y.Map<unknown>,
  currentUsername: string,
  requiredValidations: number,
  stats: CellAuditStats | undefined,
): { validationStatus: ValidationStatus; activeValidators: string[] } {
  if (!translated || !translated.trim()) {
    return { validationStatus: "empty", activeValidators: [] }
  }

  // Prefer D1 stats when present — same source of truth as the project-wide
  // health view. Fall back to walking cell.edits only when stats aren't
  // available yet (initial loading, isolated tests).
  if (stats) {
    const active = stats.activeValidators
    return {
      validationStatus: classifyValidators(active, currentUsername, requiredValidations),
      activeValidators: active,
    }
  }

  const active = readLatestActiveValidators(cell)
  return {
    validationStatus: classifyValidators(active, currentUsername, requiredValidations),
    activeValidators: active,
  }
}

function buildCellData(
  cell: Y.Map<unknown>,
  fileId: string,
  username: string,
  requiredValidations: number,
  stats: CellAuditStats | undefined,
): CellData {
  const frag = cell.get("translatedXml") as Y.XmlFragment | undefined
  const translated = frag ? getPlainText(frag) : ((cell.get("translated") as string) || "")
  const historyArr = cell.get("history") as Y.Array<CellHistoryEntry> | undefined
  const history: CellHistoryEntry[] = historyArr ? historyArr.toArray() : []
  const threads = extractThreadsFromCell(cell)
  const source = cell.get("__source") as
    | { metadata?: {
        attachments?: Record<string, CodexCellAttachment>
        selectedAudioId?: string
        selectedGeneratedVoiceAudioId?: string
        audioTimings?: Record<string, WordTiming[]>
        ttsSettings?: CellTtsSettings
        cellLabel?: string
        data?: { startTime?: number; endTime?: number }
      } }
    | undefined
  const cellLabel = source?.metadata?.cellLabel
  const startTime = source?.metadata?.data?.startTime
  const endTime = source?.metadata?.data?.endTime
  const { validationStatus, activeValidators } = deriveValidationStatus(
    translated, cell, username, requiredValidations, stats,
  )
  const editsArr = cell.get("edits") as Y.Array<Y.Map<unknown>> | undefined
  const validationHistory: EditValidationSummary[] = []
  if (editsArr) {
    for (let i = 0; i < editsArr.length; i++) {
      const snap = snapshotEntry(editsArr.get(i))
      if (snap.editMap[0] !== "value") continue
      const active = snap.validatedBy.filter(v => !v.isDeleted).map(v => v.username)
      validationHistory.push({
        authors: snap.authors,
        timestamp: snap.timestamp,
        type: snap.type,
        editMap: snap.editMap,
        value: snap.value,
        validatorsActive: active,
        validatorsAll: snap.validatedBy,
      })
    }
  }
  return {
    id: cell.get("id") as string,
    fileId,
    original: cell.get("original") as string,
    originalHtml: cell.get("originalHtml") as string | undefined,
    translated,
    ...(frag ? { translatedXml: frag } : {}),
    context: cell.get("context") as string,
    group: cell.get("group") as string,
    section: cell.get("section") as string | undefined,
    globalReferences: cell.get("globalReferences") as string[] | undefined,
    type: cell.get("type") as string,
    status: deriveStatus(translated, history),
    validationStatus,
    activeValidators,
    validationHistory,
    history,
    threads,
    sourceLocation: cell.get("sourceLocation") as SourceLocation | undefined,
    backtranslation: cell.get("backtranslation") as string | undefined,
    backtranslationUpdatedAt: cell.get("backtranslationUpdatedAt") as string | undefined,
    backtranslationForText: cell.get("backtranslationForText") as string | undefined,
    attachments: source?.metadata?.attachments,
    selectedAudioId: source?.metadata?.selectedAudioId,
    selectedGeneratedVoiceAudioId: source?.metadata?.selectedGeneratedVoiceAudioId,
    audioTimings: source?.metadata?.audioTimings,
    ttsSettings: source?.metadata?.ttsSettings,
    ...(cellLabel ? { cellLabel } : {}),
    ...(typeof startTime === "number" ? { startTime } : {}),
    ...(typeof endTime === "number" ? { endTime } : {}),
    waivers: (cell.get("waivers") as import("@/lib/parsers/types").RuleWaiver[] | undefined),
  }
}

export function useCells(
  doc: Y.Doc | null,
  fileId: string,
  username = "local",
  requiredValidations = 1,
  /** D1-backed audit stats keyed by cellId. When provided, validation status
   *  and active validators come from here — Y.Doc cell.edits walk is the
   *  fallback for cells without stats yet (initial load, isolated tests).
   *  Project-wide validation views live elsewhere; this hook stays per-file. */
  auditStats: ReadonlyMap<string, CellAuditStats> = EMPTY_STATS,
): CellData[] {
  const [cells, setCells] = useState<CellData[]>([])
  // Per-cell cache keyed by cell id. Entries are reused across observer fires
  // when the cell's Yjs content didn't change, so consumers see referentially
  // stable cell objects (lets React.memo skip unaffected rows).
  const cacheRef = useRef<Map<string, CellData>>(new Map())
  // Stats accessed via a ref so the main useLayoutEffect doesn't need to
  // re-run when stats change — buildOrEnsure deref's it on each rebuild.
  // A separate effect below diffs old vs new stats and marks just the
  // cells whose stats actually changed as dirty (preserving cache stability
  // for unaffected cells, which matters on 30k-cell files).
  const statsRef = useRef<ReadonlyMap<string, CellAuditStats>>(auditStats)
  statsRef.current = auditStats
  const prevStatsRef = useRef<ReadonlyMap<string, CellAuditStats>>(EMPTY_STATS)
  // Wired by the main useLayoutEffect; null before the effect runs and after
  // its cleanup. Outer effects call it to enqueue dirty-cell IDs into the
  // main effect's flush pipeline.
  const markDirtyRef = useRef<((ids: Iterable<string>) => void) | null>(null)

  // useLayoutEffect (not useEffect) so the initial rebuildFromScratch + setCells
  // happens synchronously before the browser paints. Otherwise the render where
  // doc transitions from null → loaded paints with cells === [], briefly showing
  // the "no cells" empty state before useEffect fires and populates them.
  useLayoutEffect(() => {
    if (!doc) { setCells([]); cacheRef.current.clear(); return }

    const cellsMap = doc.getMap("cells")
    const orderArray = doc.getArray<string>("order")
    const cache = cacheRef.current
    cache.clear()

    // Ordered array of CellData references + id→index lookup. Kept across
    // flushes so a single-cell edit to a 30k-row Bible doesn't re-walk the
    // whole order list — we patch the one slot in place and hand React a
    // shallow copy (V8's Array#slice is ~1–2ms for 30k refs; the old
    // computeOrdered + array push loop was 14–20ms).
    let ordered: CellData[] = []
    const idToIndex = new Map<string, number>()

    function buildOrEnsure(id: string): CellData | null {
      let entry = cache.get(id)
      if (entry) return entry
      const cell = cellsMap.get(id) as Y.Map<unknown> | undefined
      if (!cell) return null
      entry = buildCellData(cell, fileId, username, requiredValidations, statsRef.current.get(id))
      cache.set(id, entry)
      return entry
    }

    function rebuildFromScratch(): void {
      const ids = orderArray.toArray()
      const next: CellData[] = []
      idToIndex.clear()
      const seen = new Set<string>()
      for (const id of ids) {
        seen.add(id)
        const entry = buildOrEnsure(id)
        if (!entry) continue
        idToIndex.set(id, next.length)
        next.push(entry)
      }
      for (const id of [...cache.keys()]) {
        if (!seen.has(id)) cache.delete(id)
      }
      ordered = next
    }

    rebuildFromScratch()
    setCells(ordered)

    const dirtyIds = new Set<string>()
    let fullRebuild = false
    let orderTopologyDirty = false
    let scheduled = false

    function flush() {
      scheduled = false
      const end = perfMark("useCells.flush")

      // Full rebuild path: topology or key churn on cellsMap.
      if (fullRebuild || orderTopologyDirty) {
        cache.clear()
        idToIndex.clear()
        fullRebuild = false
        orderTopologyDirty = false
        const dirtySnapshot = dirtyIds.size
        dirtyIds.clear()
        rebuildFromScratch()
        setCells(ordered.slice())
        perfLog(`useCells.flush full-rebuild dirty=${dirtySnapshot} ordered=${ordered.length}`)
        end()
        return
      }

      if (dirtyIds.size === 0) { end(); return }

      // Incremental patch: only rebuild the dirty cells' entries, splice them
      // into a shallow copy of `ordered`. React sees a new array ref so the
      // consuming tree re-renders, but unchanged CellData refs are preserved
      // so React.memo on rows skips everyone but the typed cell.
      const dirtyCount = dirtyIds.size
      const next = ordered.slice()
      for (const id of dirtyIds) {
        const idx = idToIndex.get(id)
        if (idx === undefined) continue  // cell not in current order (was removed between events); ignore
        cache.delete(id)
        const entry = buildOrEnsure(id)
        if (!entry) continue
        next[idx] = entry
      }
      dirtyIds.clear()
      ordered = next
      setCells(next)
      perfLog(`useCells.flush incremental dirty=${dirtyCount} ordered=${ordered.length}`)
      end()
    }

    function schedule() {
      if (scheduled) return
      scheduled = true
      // Yjs observers can fire synchronously during another component's render
      // (e.g. TipTap binding initialization triggers a Y op). Defer via
      // queueMicrotask so React doesn't warn about updating mid-render.
      queueMicrotask(flush)
    }

    function onCellsChange(events: Y.YEvent<Y.AbstractType<unknown>>[]) {
      for (const ev of events) {
        // observeDeep on cellsMap: the event path is relative to cellsMap. A
        // direct change to cellsMap (key add/remove) has path.length === 0;
        // changes nested inside a cell have path[0] === cellId.
        if (ev.path.length === 0) {
          fullRebuild = true
          break
        }
        const head = ev.path[0]
        if (typeof head === "string") {
          dirtyIds.add(head)
        } else {
          fullRebuild = true
          break
        }
      }
      schedule()
    }

    function onOrderChange() {
      // Any insert/move/delete in the order array can shift indices — our
      // idToIndex map is invalid. Mark for full rebuild.
      orderTopologyDirty = true
      schedule()
    }

    cellsMap.observeDeep(onCellsChange)
    orderArray.observe(onOrderChange)
    markDirtyRef.current = (ids: Iterable<string>) => {
      let any = false
      for (const id of ids) {
        if (idToIndex.has(id)) {
          dirtyIds.add(id)
          any = true
        }
      }
      if (any) schedule()
    }
    return () => {
      cellsMap.unobserveDeep(onCellsChange)
      orderArray.unobserve(onOrderChange)
      markDirtyRef.current = null
    }
  }, [doc, fileId, username, requiredValidations])

  // Re-derive validation fields for cells whose D1 stats changed since last
  // render. Without this, stats refreshes (30s polling, outbox-driven overlay
  // bumps) wouldn't propagate into the CellData entries already cached.
  // Diffing keeps the per-cell cache stable for cells whose stats didn't move.
  useEffect(() => {
    const prev = prevStatsRef.current
    if (prev === auditStats) return
    const changed = new Set<string>()
    for (const [id, next] of auditStats) {
      if (!statsEquivalent(prev.get(id), next)) changed.add(id)
    }
    for (const id of prev.keys()) {
      if (!auditStats.has(id)) changed.add(id)
    }
    prevStatsRef.current = auditStats
    if (changed.size === 0) return
    markDirtyRef.current?.(changed)
  }, [auditStats])

  return cells
}

function statsEquivalent(
  a: CellAuditStats | undefined,
  b: CellAuditStats | undefined,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.editCount !== b.editCount) return false
  if (a.lastEditEventId !== b.lastEditEventId) return false
  if (a.lastEditAt !== b.lastEditAt) return false
  if (a.contentHash !== b.contentHash) return false
  if (a.activeValidators.length !== b.activeValidators.length) return false
  // Validator order is server-determined; compare as sets via length+includes.
  for (const u of a.activeValidators) {
    if (!b.activeValidators.includes(u)) return false
  }
  return true
}
