import React, { useEffect, useRef, useCallback, useMemo, useState, forwardRef, useImperativeHandle } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import DOMPurify from "dompurify"
import {
  Check, CheckCheck, Circle, Trash2, AlertTriangle, AlertCircle, RefreshCw,
  MessageCircle, Play, Pause, Mic, MicOff, Sparkles, FileText, History as HistoryIcon,
  ArrowRight, Activity,
} from "lucide-react"
import type { CellData } from "@/hooks/useCells"
import type { CodexCellAttachment, WordTiming } from "@/lib/codex-editor/types"
import { useFileAudioAttachments } from "@/hooks/useFileAudioAttachments"
import type { ScoredPair } from "@/lib/search/dual-index"
import type { TranslationRule, RuleInfraction, ProjectRecord } from "@/lib/parsers/types"
import { useProjectPermissions } from "@/hooks/useProjectPermissions"
import { emitTargetCellCommit, emitCellValidate, emitCellUnvalidate } from "@/lib/sync/events-emit"
import { ExamplePanel } from "./ExamplePanel"
import { HighlightedText, buildHighlightsFromExamples } from "./HighlightedText"
import { needsAttention } from "@/lib/health/decay-engine"
import { StaleSourceIndicator } from "./StaleSourceIndicator"
import { TranslatedEditor } from "./TranslatedEditor"
import { CellWaveform } from "./CellWaveform"
import { CellAudioButton } from "./CellAudioButton"
import { CellTtsButton } from "./CellTtsButton"
import { CellTranscriptPreview } from "./CellTranscriptPreview"
import { CellActionRail, RailButton, isInteractiveTarget } from "./CellActionRail"
import { CellExpansion } from "./CellExpansion"
import { tokenizeWords } from "@/lib/audio/timings"
import { useCellAudio } from "@/hooks/useCellAudio"
import { setTranscribeStatus, useTranscribeStatus } from "@/lib/audio/transcribe-status"
import { handleVoiceDropOnCell, VOICE_DRAG_MIME } from "./VoiceBar"
import {
  MAX_SELECTED,
  clearSelection,
  getSelectedIds,
  getSelectionAnchorId,
  setSelection,
  toggleSelected,
  useIsSelected,
} from "@/lib/audio/selection"
import { setTtsStatus, ttsStatusKey, useTtsStatus } from "@/lib/audio/tts"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { categorizeAiError } from "@/lib/audio/ai-error"
import { CellAiStatusPopover } from "./CellAiStatusPopover"
import { openVoiceModalFromAnywhere } from "./VoiceBar"
import { cn } from "@/lib/utils"
import { isPerfLogEnabled } from "@/lib/perf-log"
import { partitionInfractions, addWaiver, removeWaiver } from "@/lib/rules/waivers"
import { ViolationPopover } from "./ViolationPopover"
import type { RangeHighlight } from "./HighlightedText"

// Per-row render counter. Always accumulated when perf logging is on (cheap)
// but NOT auto-logged — render logs would flood the console and push the
// useful health/cells/worker logs out of the 500-entry buffer. Inspect on
// demand from the console:
//
//   window.__perfRowRenders         → Map of "cellIdPrefix" → count
//   window.__perfDumpRowRenders()   → console.table of the same
const rowRenders = new Map<string, number>()
if (typeof window !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).__perfRowRenders = rowRenders
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).__perfDumpRowRenders = () => {
    const obj: Record<string, number> = {}
    for (const [k, v] of rowRenders) obj[k] = v
    // eslint-disable-next-line no-console
    console.table(obj)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).__perfResetRowRenders = () => rowRenders.clear()
}

/** Tiny gutter badge that surfaces synth lifecycle: translating, generating,
 *  or failed. Lives in the left gutter so the loading state is anchored next
 *  to the cell that's actually working, even if the row scrolls. Errors are
 *  click-to-expand: full message + actions (set Gemini key, dismiss). */
function SynthStatusBadge({
  status, cellId,
}: {
  status: ReturnType<typeof useTtsStatus>
  cellId: string
}) {
  if (status.kind === "loading") {
    const isTranslating = status.file === "Translating…"
    const pct = !isTranslating && status.total > 0
      ? Math.round((status.loaded / status.total) * 100)
      : null
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-medium text-primary"
        title={isTranslating ? "Translating before voicing" : pct != null ? `Loading voice model (${pct}%)` : "Loading voice model"}
      >
        <span className="h-1 w-1 animate-pulse rounded-full bg-primary" />
        {isTranslating
          ? "Translating"
          : pct != null
            ? <>Loading <span className="tabular-nums">{pct}%</span></>
            : "Loading"}
      </span>
    )
  }
  if (status.kind === "synthesizing") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-medium text-primary"
        title="Generating audio…"
      >
        <span className="h-1 w-1 animate-pulse rounded-full bg-primary" />
        Voicing
      </span>
    )
  }
  if (status.kind === "error") {
    const error = categorizeAiError(status.message)
    const dismiss = () => setTtsStatus(ttsStatusKey(cellId), { kind: "idle" })
    const actions = []
    if (error.category === "missing-gemini-key") {
      actions.push({
        label: "Add Gemini API key",
        primary: true,
        onClick: () => openVoiceModalFromAnywhere("apiKey"),
      })
    } else if (error.category === "translation-not-configured" || error.category === "no-source-text") {
      // Soft fixes — no inline action available; the popover body still
      // explains what to do.
    } else if (error.category === "git-project-unsupported" || error.category === "sign-in-required") {
      // Same — body covers it.
    } else {
      actions.push({
        label: "Open voice settings",
        onClick: () => openVoiceModalFromAnywhere(),
      })
    }
    return (
      <CellAiStatusPopover
        error={error}
        actions={actions}
        onDismiss={dismiss}
        trigger={
          <button
            type="button"
            className="inline-flex max-w-[80px] cursor-pointer items-center gap-1 truncate rounded-full bg-destructive/15 px-1.5 py-0.5 text-[9px] font-medium text-destructive hover:bg-destructive/25"
          >
            Failed
          </button>
        }
      />
    )
  }
  return null
}

function ValidationHistoryTimeline({
  entries, currentUsername,
}: {
  entries: import("@/hooks/useCells").EditValidationSummary[]
  currentUsername: string
}) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  // entries are value-editMap only, oldest-first. The last entry IS the current
  // state (already shown above the divider), so skip it. Show remaining newest-first.
  const historical = entries.slice(0, -1).reverse()
  if (historical.length === 0) return null

  return (
    <>
      <div className="my-1 h-px bg-border" />
      <div className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">History</div>
      <ul className="space-y-0.5">
        {historical.map((entry, i) => {
          const snippet = typeof entry.value === "string"
            ? (entry.value.length > 40 ? entry.value.slice(0, 40) + "…" : entry.value)
            : ""
          const date = new Date(entry.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" })
          const authors = entry.authors.join(", ")
          const expanded = expandedIdx === i
          return (
            <li key={`${entry.timestamp}-${i}`} className="rounded text-xs">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-1 py-1 text-left hover:bg-muted/50"
                onClick={() => setExpandedIdx(expanded ? null : i)}
              >
                <span className="truncate">
                  <span className="text-muted-foreground">{date} · </span>
                  <span>{authors}</span>
                </span>
              </button>
              {snippet && (
                <div className="px-1 pb-1 text-[11px] italic text-muted-foreground/80 truncate">"{snippet}"</div>
              )}
              {expanded && (
                <ul className="border-l border-border/50 pl-2 ml-1 mb-1 space-y-0.5">
                  {entry.validatorsAll.length === 0 ? (
                    <li className="px-1 py-0.5 text-[11px] text-muted-foreground/60">No validators on this state</li>
                  ) : entry.validatorsAll.map(v => (
                    <li
                      key={v.username}
                      className={cn(
                        "px-1 py-0.5 text-[11px] flex items-center gap-1",
                        v.isDeleted && "text-muted-foreground/50 line-through",
                      )}
                    >
                      <span>{v.username}{v.username === currentUsername ? " (you)" : ""}</span>
                      <span className="text-muted-foreground/60 ml-auto">
                        {new Date(v.updatedTimestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </>
  )
}

// Stable empty sentinels so per-cell "map.get(id) ?? []" derivations keep a
// steady reference when the cell has no entry — otherwise every render would
// mint a fresh [] and break React.memo for every row.
const EMPTY_EXAMPLES: ScoredPair[] = []
const EMPTY_INFRACTIONS: RuleInfraction[] = []
const SELECTION_DRAG_THRESHOLD_PX = 3
const SELECTION_EDGE_SCROLL_ZONE_PX = 56
const SELECTION_EDGE_SCROLL_STEP_PX = 22

export interface EditorTableHandle {
  scrollToCellIndex: (index: number) => void
  getCurrentIndex?: () => number
  /** Briefly outline a cell after a "Go to cell" so the user sees where the search landed. */
  flashCell: (cellId: string, searchTerm: string) => void
}

interface EditorTableProps {
  project: ProjectRecord
  cells: CellData[]
  username: string
  /** Called after a successful `target.cell.commit` enqueue so the parent
   *  refetches the cells projection. */
  onCellCommitted?: () => void | Promise<void>
  /** Map of cellId → presence holder label. When present, the cell editor
   *  goes read-only with an "Alice is editing" banner. */
  cellLockHolders?: ReadonlyMap<string, string>
  /** Cell ids whose remote value changed while this client held the focus
   *  lock — surfaces the discard-and-reload banner. */
  cellsWithRemoteChange?: ReadonlySet<string>
  /** Parent-managed focus claim/release (per-cell). */
  onClaimCell?: (cellId: string) => void
  onReleaseCell?: (cellId: string) => void
  /** Drop the "remote-changed-while-editing" flag for a cell. */
  onAckRemoteChange?: (cellId: string) => void
  isCompletionConfigured: boolean
  isCompletionAvailable: boolean
  completing: Map<string, string>
  examples: Map<string, ScoredPair[]>
  errors: Map<string, string>
  onCompleteSingle: (cell: CellData) => void
  onCompleteBatch: (cells: CellData[]) => void
  healthMap: Map<string, number>
  infractions?: Map<string, RuleInfraction[]>
  rules?: TranslationRule[]
  onInfractionClick?: (ruleId: string) => void
  isBacktranslationConfigured?: boolean
  onBacktranslate?: (cell: CellData) => void
  backtranslating?: Set<string>
  backtranslationErrors?: Map<string, string>
  cellOpenCommentCount?: Map<string, number>
  onOpenComments?: (cellId: string) => void
  onOpenHistory?: (cellId: string) => void
  activeCueIndex?: number
  onSeekToCue?: (cellId: string) => void
  lineNumbersEnabled: boolean
  cellLabelsEnabled: boolean
  sourceTextDirection: "ltr" | "rtl"
  targetTextDirection: "ltr" | "rtl"
  isAnonymous?: boolean
  onJumpToCell?: (cellId: string) => void
  /** Called when user clicks a disabled sparkle while AI is not yet configured. */
  onAiSetupNeeded?: () => void
  /** Called when the user clicks the mic button on a cell. The parent owns
   *  the recording modal so it can persist across cell navigation. */
  onOpenRecording?: (cellId: string) => void
  /** Re-read the project record from IDB after a settings change (e.g. voice library edits). */
  onProjectChanged?: () => void
  /** Phase 5 / AD-9 — set of cell ids whose source has advanced since the
   *  translator's last commit. When provided, each row renders the small
   *  StaleSourceIndicator badge next to its validation status. Parent fetches
   *  once per file via `useStaleSourceCells` so we don't issue N requests. */
  staleCellIds?: ReadonlySet<string>
}

export const EditorTable = forwardRef<EditorTableHandle, EditorTableProps>(function EditorTable({
  project, cells, username, isCompletionConfigured, isCompletionAvailable,
  completing, examples, errors,
  onCompleteSingle, onCompleteBatch, healthMap,
  infractions = new Map(), rules = [], onInfractionClick,
  isBacktranslationConfigured, onBacktranslate, backtranslating, backtranslationErrors,
  cellOpenCommentCount, onOpenComments, onOpenHistory,
  activeCueIndex, onSeekToCue,
  lineNumbersEnabled, cellLabelsEnabled, sourceTextDirection, targetTextDirection,
  isAnonymous, onJumpToCell, onAiSetupNeeded, onOpenRecording,
  onProjectChanged,
  onCellCommitted,
  cellLockHolders,
  cellsWithRemoteChange,
  onClaimCell, onReleaseCell, onAckRemoteChange,
  staleCellIds,
}, ref) {
  const permissions = useProjectPermissions(project)
  const canEdit = permissions.canEditContent
  const parentRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)
  const dragCells = useRef<Set<string>>(new Set())
  const cellsRef = useRef(cells)
  const selectionDragRef = useRef<{
    pointerId: number
    anchorIndex: number
    lastIndex: number
    startX: number
    startY: number
    didDrag: boolean
  } | null>(null)
  const selectionDragAbortRef = useRef<AbortController | null>(null)
  const selectionAutoScrollFrameRef = useRef<number | null>(null)
  const selectionPointerYRef = useRef<number | null>(null)
  const previousBodyUserSelectRef = useRef<string | null>(null)

  useEffect(() => {
    cellsRef.current = cells
  }, [cells])

  // Durable cell audio (AD-2 cell.audio.* grammar). Per-file read; overlay each
  // cell's attachments + selected clips onto CellData so the existing audio
  // controllers (which read cell.attachments / selectedAudioId) light up.
  const audioFileId = cells[0]?.fileId ?? null
  const { byCellId: audioByCellId } = useFileAudioAttachments(project.id, audioFileId)
  const cellsWithAudio = useMemo(() => {
    if (audioByCellId.size === 0) return cells
    return cells.map((c) => {
      const entry = audioByCellId.get(c.id)
      if (!entry) return c
      const attachments: Record<string, CodexCellAttachment> = {}
      for (const [audioId, a] of Object.entries(entry.attachments)) {
        attachments[audioId] = { url: a.url, type: "audio" }
      }
      return {
        ...c,
        attachments,
        selectedAudioId: entry.selectedAudioId ?? undefined,
        selectedGeneratedVoiceAudioId: entry.selectedGeneratedVoiceAudioId ?? undefined,
        audioTimings: entry.audioTimings as Record<string, WordTiming[]>,
      }
    })
  }, [cells, audioByCellId])

  const ruleMap = useMemo(() => new Map(rules.map((r) => [r.id, r])), [rules])

  const virtualizer = useVirtualizer({
    count: cells.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 90,
  })

  useImperativeHandle(ref, () => ({
    scrollToCellIndex(index: number) {
      if (index >= 0 && index < cells.length) {
        virtualizer.scrollToIndex(index, { align: "center" })
      }
    },
    getCurrentIndex: () => 0,
    flashCell(cellId, _searchTerm) {
      // Defer to next frame: the virtualizer may still be scrolling, so the
      // DOM node we want might not exist yet.
      requestAnimationFrame(() => {
        const root = parentRef.current
        if (!root) return
        const el = root.querySelector<HTMLElement>(`[data-cell-id="${CSS.escape(cellId)}"]`)
        if (!el) return
        el.classList.add("codex-search-flash")
        window.setTimeout(() => el.classList.remove("codex-search-flash"), 1800)
      })
    },
  }), [virtualizer, cells.length])

  const clampCellIndex = useCallback((index: number) => {
    const last = cellsRef.current.length - 1
    if (last < 0) return -1
    return Math.max(0, Math.min(last, index))
  }, [])

  const findCellIndex = useCallback((cellId: string | null | undefined) => {
    if (!cellId) return -1
    return cellsRef.current.findIndex((c) => c.id === cellId)
  }, [])

  const selectRangeByIndexes = useCallback((anchorIndex: number, focusIndex: number) => {
    const list = cellsRef.current
    if (list.length === 0) return
    const anchor = clampCellIndex(anchorIndex)
    const focus = clampCellIndex(focusIndex)
    if (anchor < 0 || focus < 0) return

    const start = focus >= anchor
      ? anchor
      : Math.max(focus, anchor - MAX_SELECTED + 1)
    const end = focus >= anchor
      ? Math.min(focus, anchor + MAX_SELECTED - 1)
      : anchor
    const ids = list.slice(start, end + 1).map((c) => c.id)
    setSelection(ids, list[anchor]?.id ?? ids[0] ?? null)
  }, [clampCellIndex])

  const getIndexAtClientY = useCallback((clientY: number) => {
    const scrollEl = parentRef.current
    const list = cellsRef.current
    if (!scrollEl || list.length === 0) return -1
    const rect = scrollEl.getBoundingClientRect()
    const yWithin = Math.max(0, Math.min(rect.height, clientY - rect.top))
    const y = scrollEl.scrollTop + yWithin
    const virtualItems = virtualizer.getVirtualItems()
    if (virtualItems.length === 0) return clampCellIndex(Math.round(y / 90))

    let nearest = virtualItems[0]
    let nearestDistance = Number.POSITIVE_INFINITY
    for (const item of virtualItems) {
      const end = item.start + item.size
      if (y >= item.start && y <= end) return clampCellIndex(item.index)
      const distance = y < item.start ? item.start - y : y - end
      if (distance < nearestDistance) {
        nearest = item
        nearestDistance = distance
      }
    }
    return clampCellIndex(nearest.index)
  }, [clampCellIndex, virtualizer])

  const updateSelectionFromPointer = useCallback((clientY: number) => {
    const drag = selectionDragRef.current
    if (!drag) return
    const nextIndex = getIndexAtClientY(clientY)
    if (nextIndex < 0 || nextIndex === drag.lastIndex) return
    drag.lastIndex = nextIndex
    selectRangeByIndexes(drag.anchorIndex, nextIndex)
  }, [getIndexAtClientY, selectRangeByIndexes])

  const scrollSelectionNearEdge = useCallback((clientY: number) => {
    const scrollEl = parentRef.current
    if (!scrollEl) return
    const rect = scrollEl.getBoundingClientRect()
    let delta = 0
    if (clientY < rect.top + SELECTION_EDGE_SCROLL_ZONE_PX) {
      delta = -SELECTION_EDGE_SCROLL_STEP_PX
    } else if (clientY > rect.bottom - SELECTION_EDGE_SCROLL_ZONE_PX) {
      delta = SELECTION_EDGE_SCROLL_STEP_PX
    }
    if (delta !== 0) scrollEl.scrollTop += delta
  }, [])

  const stopSelectionDrag = useCallback(() => {
    selectionDragAbortRef.current?.abort()
    selectionDragAbortRef.current = null
    selectionDragRef.current = null
    selectionPointerYRef.current = null
    if (selectionAutoScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(selectionAutoScrollFrameRef.current)
      selectionAutoScrollFrameRef.current = null
    }
    if (previousBodyUserSelectRef.current !== null) {
      document.body.style.userSelect = previousBodyUserSelectRef.current
      previousBodyUserSelectRef.current = null
    }
  }, [])

  const handleSelectionPointerMove = useCallback((e: PointerEvent) => {
    const drag = selectionDragRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    e.preventDefault()
    selectionPointerYRef.current = e.clientY
    if (
      !drag.didDrag &&
      (Math.abs(e.clientX - drag.startX) > SELECTION_DRAG_THRESHOLD_PX ||
        Math.abs(e.clientY - drag.startY) > SELECTION_DRAG_THRESHOLD_PX)
    ) {
      drag.didDrag = true
    }
    updateSelectionFromPointer(e.clientY)
  }, [updateSelectionFromPointer])

  const handleSelectionPointerEnd = useCallback((e: PointerEvent) => {
    const drag = selectionDragRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    e.preventDefault()
    stopSelectionDrag()
  }, [stopSelectionDrag])

  const startSelectionAutoScroll = useCallback(() => {
    if (selectionAutoScrollFrameRef.current !== null) return
    const tick = () => {
      if (!selectionDragRef.current) {
        selectionAutoScrollFrameRef.current = null
        return
      }
      const y = selectionPointerYRef.current
      if (typeof y === "number") {
        scrollSelectionNearEdge(y)
        updateSelectionFromPointer(y)
      }
      selectionAutoScrollFrameRef.current = window.requestAnimationFrame(tick)
    }
    selectionAutoScrollFrameRef.current = window.requestAnimationFrame(tick)
  }, [scrollSelectionNearEdge, updateSelectionFromPointer])

  const handleSelectionPointerDown = useCallback((
    cellId: string,
    rowIndex: number,
    e: React.PointerEvent<HTMLButtonElement>,
  ) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()

    stopSelectionDrag()

    const selectedIds = getSelectedIds()
    const isAdditive = e.metaKey || e.ctrlKey
    const isAlreadySelected = selectedIds.has(cellId)
    const anchorIndex = findCellIndex(getSelectionAnchorId())
    const shouldRange =
      !isAdditive &&
      anchorIndex >= 0 &&
      (e.shiftKey || (selectedIds.size > 0 && !isAlreadySelected))
    const startIndex = shouldRange ? anchorIndex : rowIndex

    selectionDragRef.current = {
      pointerId: e.pointerId,
      anchorIndex: clampCellIndex(startIndex),
      lastIndex: clampCellIndex(rowIndex),
      startX: e.clientX,
      startY: e.clientY,
      didDrag: false,
    }
    selectionPointerYRef.current = e.clientY

    previousBodyUserSelectRef.current = document.body.style.userSelect
    document.body.style.userSelect = "none"

    const controller = new AbortController()
    selectionDragAbortRef.current = controller
    window.addEventListener("pointermove", handleSelectionPointerMove, {
      signal: controller.signal,
    })
    window.addEventListener("pointerup", handleSelectionPointerEnd, {
      signal: controller.signal,
    })
    window.addEventListener("pointercancel", handleSelectionPointerEnd, {
      signal: controller.signal,
    })

    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // Pointer capture is a best-effort guard; window listeners still carry
      // the drag if the browser refuses capture for any reason.
    }

    if (isAdditive) {
      toggleSelected(cellId)
    } else if (shouldRange) {
      selectRangeByIndexes(anchorIndex, rowIndex)
    } else if (isAlreadySelected && selectedIds.size === 1) {
      clearSelection()
    } else {
      setSelection([cellId], cellId)
    }
    startSelectionAutoScroll()
  }, [
    clampCellIndex,
    findCellIndex,
    handleSelectionPointerEnd,
    handleSelectionPointerMove,
    selectRangeByIndexes,
    startSelectionAutoScroll,
    stopSelectionDrag,
  ])

  useEffect(() => stopSelectionDrag, [stopSelectionDrag])

  // Grid layout: [left-gutter] [source] [target]. The left 44px gutter holds
  // only the line number / cell label and the validation pill. There is no
  // right gutter — the floating action rail (sparkle / mic / tts / comment /
  // expand) is absolutely positioned at the row's right edge so it doesn't
  // claim layout space when collapsed. The target column reserves pr-9 so the
  // ever-present expand chevron never overlaps text.
  const gridCols = "grid-cols-[44px_1fr_1fr]"

  const handleMouseUp = useCallback(() => {
    if (isDragging.current && dragCells.current.size > 1) {
      const selected = cells.filter((c) => dragCells.current.has(c.id))
      onCompleteBatch(selected)
    }
    isDragging.current = false
    dragCells.current = new Set()
  }, [cells, onCompleteBatch])

  // Stable drag handlers keyed by cellId. Inline closures per row would mint
  // a fresh function every render and defeat React.memo on MemoizedRow.
  const handleDragStart = useCallback((cellId: string) => {
    isDragging.current = true
    dragCells.current = new Set([cellId])
  }, [])
  const handleDragEnter = useCallback((cellId: string) => {
    if (isDragging.current) dragCells.current.add(cellId)
  }, [])
  const getVoiceTakeCells = useCallback((startIndex: number, count: number) => {
    return cellsRef.current.slice(startIndex, startIndex + count)
  }, [])

  return (
    <div ref={parentRef} className="h-full overflow-auto" onMouseUp={handleMouseUp}>
      <div className={cn("sticky top-0 z-10 grid gap-2 border-b bg-background px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground", gridCols)}>
        <div />
        <div>Source</div>
        <div className="border-l border-border/60 pl-3">Target</div>
      </div>

      <div style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const cell = cellsWithAudio[virtualRow.index]
          // The positioning wrapper lives OUTSIDE MemoizedRow. When the typed
          // cell grows in height, every row below it gets a new virtualRow.start
          // — if that value crossed the memo boundary, every shifted row would
          // re-render. Here the position-carrying div is a fresh element each
          // parent render (cheap), but MemoizedRow below it sees stable props.
          return (
            <div
              key={cell.id}
              data-cell-id={cell.id}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <MemoizedRow
                project={project}
                cell={cell}
                isStaleSource={staleCellIds?.has(cell.id) ?? false}
                username={username}
                editable={canEdit}
                onCellCommitted={onCellCommitted}
                lockHolderLabel={cellLockHolders?.get(cell.id) ?? null}
                remoteChangedWhileFocused={cellsWithRemoteChange?.has(cell.id) ?? false}
                onClaimCell={onClaimCell}
                onReleaseCell={onReleaseCell}
                onAckRemoteChange={onAckRemoteChange}
                isCompletionConfigured={isCompletionConfigured}
                isCompletionAvailable={isCompletionAvailable}
                examples={examples}
                completing={completing}
                errors={errors}
                healthMap={healthMap}
                infractions={infractions}
                ruleMap={ruleMap}
                onCompleteSingle={onCompleteSingle}
                onInfractionClick={onInfractionClick}
                isBacktranslationConfigured={isBacktranslationConfigured}
                backtranslating={backtranslating}
                backtranslationErrors={backtranslationErrors}
                onBacktranslate={onBacktranslate}
                cellOpenCommentCount={cellOpenCommentCount}
                onOpenComments={onOpenComments}
                onOpenHistory={onOpenHistory}
                activeCueIndex={activeCueIndex}
                onSeekToCue={onSeekToCue}
                rowIndex={virtualRow.index}
                lineNumbersEnabled={lineNumbersEnabled}
                cellLabelsEnabled={cellLabelsEnabled}
                sourceTextDirection={sourceTextDirection}
                targetTextDirection={targetTextDirection}
                gridCols={gridCols}
                isAnonymous={isAnonymous}
                onJumpToCell={onJumpToCell}
                onAiSetupNeeded={onAiSetupNeeded}
                onOpenRecording={onOpenRecording}
                onProjectChanged={onProjectChanged}
                onDragStart={handleDragStart}
                onDragEnter={handleDragEnter}
                onSelectionPointerDown={handleSelectionPointerDown}
                getVoiceTakeCells={getVoiceTakeCells}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
})

/**
 * Memoized row wrapper. Owns every per-cell derivation that used to live in
 * the parent render loop — `examples.get(id) ?? []` style lookups, the
 * `isActiveCue`/`hasOpenComments` booleans, the drag handler binding to
 * cell.id. Moving them here lets React.memo actually hold: when typing in
 * cell X rebuilds only X's CellData (per the useCells cache), rows for every
 * OTHER cell receive the same `cell` ref, same stable maps, same stable
 * callbacks — memo hits and they skip render entirely.
 *
 * The parent (EditorTable) still re-renders per keystroke; this wrapper is
 * the cutoff point where the re-render tree gets pruned.
 */
interface MemoizedRowProps {
  project: ProjectRecord
  cell: CellData
  username: string
  editable: boolean
  /** Phase 5 / AD-9: source has advanced since this target was last committed.
   *  Resolved once per file by the parent (membership look-up) so this prop
   *  is just a stable boolean — preserves the row's React.memo invariant. */
  isStaleSource: boolean
  onCellCommitted?: () => void | Promise<void>
  lockHolderLabel: string | null
  remoteChangedWhileFocused: boolean
  onClaimCell?: (cellId: string) => void
  onReleaseCell?: (cellId: string) => void
  onAckRemoteChange?: (cellId: string) => void
  isCompletionConfigured: boolean
  isCompletionAvailable: boolean
  examples: Map<string, ScoredPair[]>
  completing: Map<string, string>
  errors: Map<string, string>
  healthMap: Map<string, number>
  infractions: Map<string, RuleInfraction[]>
  ruleMap: Map<string, TranslationRule>
  onCompleteSingle: (cell: CellData) => void
  onInfractionClick?: (ruleId: string) => void
  isBacktranslationConfigured?: boolean
  backtranslating?: Set<string>
  backtranslationErrors?: Map<string, string>
  onBacktranslate?: (cell: CellData) => void
  cellOpenCommentCount?: Map<string, number>
  onOpenComments?: (cellId: string) => void
  onOpenHistory?: (cellId: string) => void
  activeCueIndex?: number
  onSeekToCue?: (cellId: string) => void
  rowIndex: number
  lineNumbersEnabled: boolean
  cellLabelsEnabled: boolean
  sourceTextDirection: "ltr" | "rtl"
  targetTextDirection: "ltr" | "rtl"
  gridCols: "grid-cols-[44px_1fr_1fr]"
  isAnonymous?: boolean
  onJumpToCell?: (cellId: string) => void
  onAiSetupNeeded?: () => void
  onOpenRecording?: (cellId: string) => void
  onProjectChanged?: () => void
  onDragStart: (cellId: string) => void
  onDragEnter: (cellId: string) => void
  onSelectionPointerDown: (
    cellId: string,
    rowIndex: number,
    e: React.PointerEvent<HTMLButtonElement>,
  ) => void
  getVoiceTakeCells: (startIndex: number, count: number) => CellData[]
}

const MemoizedRow = React.memo(function MemoizedRow(props: MemoizedRowProps) {
  const {
    cell, examples, completing, errors, healthMap, infractions,
    backtranslating, backtranslationErrors, cellOpenCommentCount,
    activeCueIndex, rowIndex, gridCols,
    onDragStart: onDragStartParent, onDragEnter: onDragEnterParent,
    onSelectionPointerDown: onSelectionPointerDownParent,
    getVoiceTakeCells,
    project, username, editable, isCompletionConfigured, isCompletionAvailable,
    ruleMap, onCompleteSingle, onInfractionClick,
    isBacktranslationConfigured, onBacktranslate,
    onOpenComments, onOpenHistory,
    onSeekToCue, lineNumbersEnabled, cellLabelsEnabled,
    sourceTextDirection, targetTextDirection, isAnonymous,
    onJumpToCell, onAiSetupNeeded, onOpenRecording, onProjectChanged,
    onCellCommitted, lockHolderLabel, remoteChangedWhileFocused,
    onClaimCell, onReleaseCell, onAckRemoteChange,
    isStaleSource,
  } = props

  const cellId = cell.id
  if (isPerfLogEnabled()) {
    const key = cellId.slice(0, 8)
    rowRenders.set(key, (rowRenders.get(key) ?? 0) + 1)
  }
  const cellExamples = useMemo(() => examples.get(cellId) ?? EMPTY_EXAMPLES, [examples, cellId])
  const highlights = useMemo(() => buildHighlightsFromExamples(cellExamples), [cellExamples])
  const cellInfractions = useMemo(() => infractions.get(cellId) ?? EMPTY_INFRACTIONS, [infractions, cellId])

  const { active: activeInfractions, waived: waivedInfractions } = useMemo(
    () => partitionInfractions(cellInfractions, cell.waivers),
    [cellInfractions, cell.waivers],
  )

  const completingState = completing.get(cellId)
  const isLoading = completingState === "searching" || completingState === "generating"
  const error = errors.get(cellId)
  const health = healthMap.get(cellId)
  const isBacktranslating = backtranslating?.has(cellId)
  const backtranslationError = backtranslationErrors?.get(cellId)
  const openCommentCount = cellOpenCommentCount?.get(cellId) ?? 0
  const hasOpenComments = openCommentCount > 0
  const isActiveCue = activeCueIndex !== undefined && activeCueIndex === rowIndex

  // Bind the stable parent (cellId) => void handlers to this row's cellId.
  // Stable per-row because both parent callbacks and cellId are stable.
  const handleDragStart = useCallback(() => onDragStartParent(cellId), [onDragStartParent, cellId])
  const handleDragEnter = useCallback(() => onDragEnterParent(cellId), [onDragEnterParent, cellId])
  const handleSelectionPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => onSelectionPointerDownParent(cellId, rowIndex, e),
    [onSelectionPointerDownParent, cellId, rowIndex],
  )

  return (
    <div
      className={cn(
        "transition-colors duration-150 ease-out hover:bg-muted/20",
        hasOpenComments && "border-l-2 border-l-blue-400",
        isActiveCue && "bg-primary/5 ring-1 ring-primary/30",
      )}
    >
      <EditorRow
        project={project}
        cell={cell}
        username={username}
        editable={editable}
        isStaleSource={isStaleSource}
        isCompletionConfigured={isCompletionConfigured}
        isCompletionAvailable={isCompletionAvailable}
        isLoading={isLoading}
        cellExamples={cellExamples}
        highlights={highlights}
        error={error}
        health={health}
        cellInfractions={activeInfractions}
        waivedInfractions={waivedInfractions}
        ruleMap={ruleMap}
        onCompleteSingle={onCompleteSingle}
        onInfractionClick={onInfractionClick}
        isBacktranslationConfigured={isBacktranslationConfigured}
        isBacktranslating={isBacktranslating}
        backtranslationError={backtranslationError}
        onBacktranslate={onBacktranslate}
        openCommentCount={openCommentCount}
        onOpenComments={onOpenComments}
        onOpenHistory={onOpenHistory}
        isActiveCue={isActiveCue}
        onSeekToCue={onSeekToCue}
        rowIndex={rowIndex}
        lineNumbersEnabled={lineNumbersEnabled}
        cellLabelsEnabled={cellLabelsEnabled}
        sourceTextDirection={sourceTextDirection}
        targetTextDirection={targetTextDirection}
        gridCols={gridCols}
        isAnonymous={isAnonymous}
        onJumpToCell={onJumpToCell}
        onAiSetupNeeded={onAiSetupNeeded}
        onOpenRecording={onOpenRecording}
        onProjectChanged={onProjectChanged}
        onDragStart={handleDragStart}
        onDragEnter={handleDragEnter}
        onSelectionPointerDown={handleSelectionPointerDown}
        getVoiceTakeCells={getVoiceTakeCells}
        onCellCommitted={onCellCommitted}
        lockHolderLabel={lockHolderLabel}
        remoteChangedWhileFocused={remoteChangedWhileFocused}
        onClaimCell={onClaimCell}
        onReleaseCell={onReleaseCell}
        onAckRemoteChange={onAckRemoteChange}
      />
    </div>
  )
})

interface EditorRowProps {
  project: ProjectRecord
  cell: CellData
  username: string
  editable: boolean
  /** Phase 5 / AD-9 — true when the source has advanced since the last
   *  target commit. Renders a small warning badge next to the validation
   *  status. Computed once-per-file by the parent. */
  isStaleSource: boolean
  onCellCommitted?: () => void
  lockHolderLabel: string | null
  remoteChangedWhileFocused: boolean
  onClaimCell?: (cellId: string) => void
  onReleaseCell?: (cellId: string) => void
  onAckRemoteChange?: (cellId: string) => void
  isCompletionConfigured: boolean
  isCompletionAvailable: boolean
  isLoading: boolean
  cellExamples: ScoredPair[]
  highlights: ReturnType<typeof buildHighlightsFromExamples>
  error?: string
  health: number | undefined
  cellInfractions: RuleInfraction[]
  waivedInfractions: RuleInfraction[]
  ruleMap: Map<string, TranslationRule>
  onCompleteSingle: (cell: CellData) => void
  onInfractionClick?: (ruleId: string) => void
  isBacktranslationConfigured?: boolean
  isBacktranslating?: boolean
  backtranslationError?: string
  onBacktranslate?: (cell: CellData) => void
  openCommentCount: number
  onOpenComments?: (cellId: string) => void
  onOpenHistory?: (cellId: string) => void
  isActiveCue?: boolean
  onSeekToCue?: (cellId: string) => void
  onDragStart: () => void
  onDragEnter: () => void
  onSelectionPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void
  getVoiceTakeCells: (startIndex: number, count: number) => CellData[]
  rowIndex: number
  lineNumbersEnabled: boolean
  cellLabelsEnabled: boolean
  sourceTextDirection: "ltr" | "rtl"
  targetTextDirection: "ltr" | "rtl"
  gridCols: "grid-cols-[44px_1fr_1fr]"
  isAnonymous?: boolean
  onJumpToCell?: (cellId: string) => void
  onAiSetupNeeded?: () => void
  onOpenRecording?: (cellId: string) => void
  onProjectChanged?: () => void
}

function EditorRow({
  project, cell, username, editable, isCompletionConfigured, isCompletionAvailable, isLoading,
  cellExamples, highlights, error, health,
  cellInfractions, waivedInfractions, ruleMap,
  onCompleteSingle, onInfractionClick,
  isBacktranslationConfigured, isBacktranslating, backtranslationError, onBacktranslate,
  openCommentCount, onOpenComments, onOpenHistory,
  isActiveCue: _isActiveCue, onSeekToCue,
  onDragStart, onDragEnter, onSelectionPointerDown,
  rowIndex, lineNumbersEnabled, cellLabelsEnabled, sourceTextDirection, targetTextDirection, gridCols,
  isAnonymous, onAiSetupNeeded, onOpenRecording,
  onCellCommitted, lockHolderLabel, remoteChangedWhileFocused,
  onClaimCell, onReleaseCell, onAckRemoteChange,
  isStaleSource,
}: EditorRowProps) {
  const [openRuleId, setOpenRuleId] = useState<string | null>(null)
  const [openRuleAnchor, setOpenRuleAnchor] = useState<HTMLElement | null>(null)
  const [examplesExpanded, setExamplesExpanded] = useState(false)
  const pendingTargetEventIdRef = useRef<string | null>(cell.targetEventId ?? null)

  useEffect(() => {
    if (cell.targetEventId) pendingTargetEventIdRef.current = cell.targetEventId
  }, [cell.targetEventId])

  const ruleSeverity = useMemo(() => {
    const m = new Map<string, "major" | "minor">()
    for (const [id, rule] of ruleMap) m.set(id, rule.severity)
    return m
  }, [ruleMap])

  const waivedRuleIds = useMemo(
    () => new Set((cell.waivers ?? []).map((w) => w.ruleId)),
    [cell.waivers],
  )

  const handleWaive = useCallback((_input: { ruleId: string; reason?: string }) => {
    // Phase 2c-gamma: waivers wrote to Y.Doc; the event-grammar version
    // is deferred to v1.x. The popover still closes so the click feels live.
    addWaiver(cell.waivers ?? [], _input, username)
    setOpenRuleId(null)
  }, [cell.waivers, username])

  const handleUnwaive = useCallback((ruleId: string) => {
    removeWaiver(cell.waivers ?? [], ruleId)
    setOpenRuleId(null)
  }, [cell.waivers])

  const sourceRanges = useMemo<RangeHighlight[]>(() => {
    const out: RangeHighlight[] = []
    const all = [...cellInfractions, ...waivedInfractions]
    for (const inf of all) {
      const waived = waivedRuleIds.has(inf.ruleId)
      const severity = ruleSeverity.get(inf.ruleId) ?? "major"
      for (const span of inf.spans) {
        if (span.side !== "source") continue
        out.push({
          start: span.start, end: span.end, ruleId: inf.ruleId,
          kind: waived ? "violation-waived" : (severity === "major" ? "violation-major" : "violation-minor"),
        })
      }
    }
    return out
  }, [cellInfractions, waivedInfractions, waivedRuleIds, ruleSeverity])

  // Phase 2c-β: target-side rendering of violations happens via the
  // ProseMirror plugin inside TranslatedEditor, so we no longer compute
  // textarea-overlay ranges. Source-side ranges still flow through
  // HighlightedText below.
  void waivedRuleIds; void cellInfractions; void waivedInfractions; void ruleSeverity

  // Editor commit path. The plain TipTap editor (TranslatedEditor) calls
  // this on idle/blur/release with the current `{value, valueHtml}` snapshot.
  // We emit a `target.cell.commit` event chained off cell.targetEventId
  // (AD-2) and pinned to cell.sourceEventId (AD-9 staleness pin), then ping
  // the parent to revalidate useCells so the projection lands.
  const handleEditorCommit = useCallback(({ value, valueHtml }: { value: string; valueHtml: string }) => {
    if (!editable) return
    if (!project.id) return
    void emitTargetCellCommit({
      projectId: project.id,
      fileId: cell.fileId,
      cellId: cell.id,
      parentId: cell.targetEventId ?? cell.sourceEventId ?? null,
      sourceEventId: cell.sourceEventId ?? null,
      value,
      valueHtml,
      author: username,
    }).then((eventId) => {
      pendingTargetEventIdRef.current = eventId
      void onCellCommitted?.()
    }).catch((err) => {
      console.warn("[editor-commit] enqueue failed:", err)
    })
  }, [editable, project.id, cell.fileId, cell.id, cell.targetEventId, cell.sourceEventId, username, onCellCommitted])

  const emitValidationChange = useCallback((validated: boolean) => {
    const editEventId = cell.targetEventId ?? pendingTargetEventIdRef.current
    if (!project.id || !editEventId) return
    const emit = validated ? emitCellValidate : emitCellUnvalidate
    void emit({
      projectId: project.id,
      fileId: cell.fileId,
      cellId: cell.id,
      editEventId,
      author: username,
    }).then(() => {
      void onCellCommitted?.()
    }).catch((err) => {
      console.warn(`[${validated ? "validate" : "unvalidate"}] emit failed:`, err)
    })
  }, [cell.fileId, cell.id, cell.targetEventId, project.id, username, onCellCommitted])

  const handleEditorFocus = useCallback(() => {
    onClaimCell?.(cell.id)
    onAckRemoteChange?.(cell.id)
  }, [cell.id, onClaimCell, onAckRemoteChange])

  const handleEditorBlurOuter = useCallback(() => {
    onReleaseCell?.(cell.id)
  }, [cell.id, onReleaseCell])

  const handleDiscardLocalAndReload = useCallback(() => {
    onAckRemoteChange?.(cell.id)
    onCellCommitted?.()
  }, [cell.id, onAckRemoteChange, onCellCommitted])

  // Detect formatting loss: source has inline style marks that the target doesn't.
  const sourceHasFormatting = Boolean(cell.originalHtml && /<(b|strong|i|em|u|s|strike|del|code)\b/i.test(cell.originalHtml))
  const targetHtml = cell.translatedHtml ?? ""
  const targetHasFormatting = /<(b|strong|i|em|u|s|strike|del|code)\b/i.test(targetHtml)
  const showFormattingLossWarning =
    sourceHasFormatting && !targetHasFormatting && cell.translated.trim().length > 0

  const healthValue = health ?? (cell.status === "validated" ? 100 : 0)

  const selectedAudio = cell.selectedAudioId ? cell.attachments?.[cell.selectedAudioId] : undefined
  const hasAudio = Boolean(selectedAudio && !selectedAudio.isDeleted)
  const cellAudioTimings = cell.selectedAudioId ? cell.audioTimings?.[cell.selectedAudioId] : undefined
  const selectedGeneratedVoice = cell.selectedGeneratedVoiceAudioId
    ? cell.attachments?.[cell.selectedGeneratedVoiceAudioId]
    : undefined
  const hasGeneratedVoice = Boolean(selectedGeneratedVoice && !selectedGeneratedVoice.isDeleted)
  const generatedVoiceTimings = cell.selectedGeneratedVoiceAudioId
    ? cell.audioTimings?.[cell.selectedGeneratedVoiceAudioId]
    : undefined

  // Minimal CodexCell shape for the audio hook — only the metadata fields it
  // actually reads (selectedAudioId, attachments). Avoids plumbing the entire
  // CodexCell through CellData.
  const cellForAudio = useMemo(() => ({
    kind: 2 as const,
    languageId: "html",
    value: cell.translated ?? "",
    metadata: {
      id: cell.id,
      type: (cell.type ?? "text") as "text",
      attachments: cell.attachments,
      selectedAudioId: cell.selectedAudioId,
    },
  } as unknown as import("@/lib/codex-editor/types").CodexCell), [
    cell.id, cell.type, cell.translated, cell.attachments, cell.selectedAudioId,
  ])
  const audioController = useCellAudio(project, cellForAudio, cell.fileId)
  const cellForGeneratedVoice = useMemo(() => ({
    kind: 2 as const,
    languageId: "html",
    value: cell.translated ?? "",
    metadata: {
      id: cell.id,
      type: (cell.type ?? "text") as "text",
      attachments: cell.attachments,
      selectedAudioId: cell.selectedGeneratedVoiceAudioId,
    },
  } as unknown as import("@/lib/codex-editor/types").CodexCell), [
    cell.id, cell.type, cell.translated, cell.attachments, cell.selectedGeneratedVoiceAudioId,
  ])
  const generatedVoiceController = useCellAudio(project, cellForGeneratedVoice, cell.fileId)

  // When this cell starts playing, gently bring it into view if it's
  // off-screen. Skips when the user is actively interacting with another cell
  // (focus inside an editable element).
  const rowRef = useRef<HTMLDivElement | null>(null)
  const wasPlayingRef = useRef(false)
  useEffect(() => {
    const wasPlaying = wasPlayingRef.current
    const anyPlaying = audioController.isPlaying || generatedVoiceController.isPlaying
    wasPlayingRef.current = anyPlaying
    if (!wasPlaying && anyPlaying && rowRef.current) {
      const rect = rowRef.current.getBoundingClientRect()
      const fullyVisible = rect.top >= 0 && rect.bottom <= window.innerHeight
      const ae = document.activeElement
      const userIsTyping = ae instanceof HTMLElement && (
        ae.isContentEditable || ae.tagName === "INPUT" || ae.tagName === "TEXTAREA"
      )
      if (!fullyVisible && !userIsTyping) {
        rowRef.current.scrollIntoView({ behavior: "smooth", block: "center" })
      }
    }
  }, [audioController.isPlaying, generatedVoiceController.isPlaying])
  const transcribeStatus = useTranscribeStatus(cell.selectedAudioId)
  const isTranscribing = transcribeStatus.kind === "loading" || transcribeStatus.kind === "transcribing"
  const transcriptPreviewRef = useRef<HTMLDivElement | null>(null)

  const handleTranscribe = useCallback(async () => {
    // Phase 2c-gamma: transcribeAndStoreTimings wrote per-word timings into
    // the per-file Y.Doc. The grammar that brings forced-alignment writebacks
    // to the event log lands in v1.x; this gesture is a no-op for now.
    const audioId = cell.selectedAudioId
    if (!audioId) return
    setTranscribeStatus(audioId, { kind: "idle" })
  }, [cell.selectedAudioId])

  // Build tooltip detail
  const lastEntry = cell.history[cell.history.length - 1]
  const exampleIds = lastEntry?.examples || []
  const healthTooltip = cell.status === "empty"
    ? undefined
    : cell.status === "validated"
      ? `Health: ${healthValue}% — validated`
      : exampleIds.length === 0
        ? `Health: ${healthValue}% — no examples`
        : `Health: ${healthValue}% — ${exampleIds.length} example${exampleIds.length !== 1 ? "s" : ""}`

  const vs = cell.validationStatus
  const [validationPopoverOpen, setValidationPopoverOpen] = useState(false)
  const isSelfValidated = cell.activeValidators.includes(username)
  const hasValidatorInfo = cell.activeValidators.length > 0 || cell.validationHistory.length > 1

  // Gate Base UI's auto-toggle: clicks on an unvalidated cell should validate
  // (not open the popover), and hovers should only open when there's actually
  // something to show. Everything else passes through to the default behavior,
  // including outside-press / escape-key closes.
  function handleOpenChange(
    nextOpen: boolean,
    details: { reason: string; cancel(): void },
  ) {
    if (!nextOpen) {
      setValidationPopoverOpen(false)
      return
    }
    if (details.reason === "trigger-press") {
      if (editable && !isSelfValidated) {
        emitValidationChange(true)
        details.cancel()
        return
      }
      setValidationPopoverOpen(true)
      return
    }
    if (details.reason === "trigger-hover" && !hasValidatorInfo) {
      details.cancel()
      return
    }
    setValidationPopoverOpen(true)
  }

  // "others" now uses a filled Circle (lucide has no dedicated filled-circle
  // icon; we render Circle with fill="currentColor"). Matches codex-editor
  // desktop AudioValidationStatusIcon's circle-filled codicon.
  const ValidationIcon = vs === "full" ? CheckCheck : vs === "self" ? Check : Circle
  const validationColorClass =
    vs === "full" ? "text-emerald-500" :
    vs === "self" ? "text-emerald-500" :
    vs === "others" ? "text-muted-foreground/60" :
    "text-muted-foreground/30"

  const hasContent = Boolean(cell.translated && cell.translated.trim())

  // AD-14: a translated cell shows an inline "needs attention" marker when its
  // decay is above the warn threshold (endorsement_count too low). Absence is
  // silence, not endorsement — there is no green "done" ring at cell scope.
  const cellNeedsAttention = hasContent && needsAttention(cell.endorsementCount ?? 0)

  const hasMajorInfraction = cellInfractions.some(
    (i) => ruleMap.get(i.ruleId)?.severity === "major",
  )
  const infractionCount = cellInfractions.length
  const infractionTooltip =
    infractionCount > 0
      ? `${infractionCount} issue${infractionCount !== 1 ? "s" : ""}${hasMajorInfraction ? " (major)" : " (minor)"}`
      : undefined

  const validationButton = hasContent ? (
    <div className="relative inline-flex items-center gap-0.5">
    <Popover open={validationPopoverOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        openOnHover
        delay={400}
        closeDelay={100}
        render={
          <button
            type="button"
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded-full transition-[transform,color] duration-150 ease-out",
              "active:scale-[0.92] disabled:cursor-not-allowed disabled:opacity-40",
              "hover:bg-muted/60",
              validationColorClass,
              vs === "none" && "hover:text-emerald-500",
              vs === "others" && "hover:text-emerald-500",
            )}
            title={healthTooltip}
            disabled={!editable}
          >
            <ValidationIcon
              className="h-3.5 w-3.5"
              strokeWidth={2.5}
              {...(vs === "others" ? { fill: "currentColor" } : {})}
            />
          </button>
        }
      />
      {cellNeedsAttention && (
        <span
          className="pointer-events-none absolute -right-1 -top-1 text-amber-500"
          title="Needs attention — this cell's neighborhood isn't validated yet"
        >
          <AlertTriangle className="h-2.5 w-2.5" strokeWidth={2.5} />
        </span>
      )}
      {vs !== "empty" && (
        <PopoverContent
          side="right"
          align="start"
          className="w-72 rounded-lg border p-2 shadow-lg"
        >
          <ul className="space-y-0.5">
            <li className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Validated by
            </li>
            {cell.activeValidators.length === 0 ? (
              <li className="px-1 py-1 text-xs text-muted-foreground">No active validators</li>
            ) : (
              cell.activeValidators.map((v) => (
                <li key={v} className="flex items-center justify-between gap-2 rounded px-1 py-1 text-xs hover:bg-muted/50">
                  <span className="truncate">{v}{v === username ? " (you)" : ""}</span>
                  {v === username && editable && (
                    <button
                      type="button"
                      className="flex-shrink-0 rounded p-0.5 text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
                      title="Remove your validation"
                      onClick={() => {
                        emitValidationChange(false)
                        setValidationPopoverOpen(false)
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </li>
              ))
            )}
          </ul>
          {cell.validationHistory.length > 0 && (
            <ValidationHistoryTimeline entries={cell.validationHistory} currentUsername={username} />
          )}
        </PopoverContent>
      )}
    </Popover>
    {/* Phase 5 / AD-9: source-changed indicator. Parent-managed mode —
        membership lookup happens once per file at ProjectWorkspace and is
        flattened to a per-row boolean here, so we pass a one-element set
        the indicator resolves trivially. Skipping the component entirely
        when !isStaleSource keeps the common (non-stale) case zero-cost
        and avoids the per-row allocation. */}
    {isStaleSource && (
      <StaleSourceIndicator
        cellId={cell.id}
        staleCellIds={new Set([cell.id])}
      />
    )}
    {infractionCount > 0 && (
      <span
        aria-label={infractionTooltip}
        title={infractionTooltip}
        className={cn(
          "pointer-events-none absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-background",
          hasMajorInfraction ? "bg-red-500" : "bg-amber-500",
        )}
      />
    )}
    </div>
  ) : null

  // SECURITY: originalHtml below is sanitized through DOMPurify.sanitize() at
  // the render boundary. Parsers only produce safe inline tags (<b>, <i>, <u>,
  // <s>, <code>). DOMPurify provides defense-in-depth against XSS.
  const showLineNumber = lineNumbersEnabled && cell.type !== "paratext"
  const showCellLabel = cellLabelsEnabled && cell.cellLabel

  // ── Hover / focus / tap state for the floating action rail ───────────────
  // Three input sources OR'd together: row hover, focus-within, tap-selected
  // (touch). Hover-leave has a 120ms grace period to prevent flicker as the
  // cursor grazes adjacent rows.
  const [isHovering, setIsHovering] = useState(false)
  const [hasFocusWithin, setHasFocusWithin] = useState(false)
  const [isTapSelected, setIsTapSelected] = useState(false)
  const hoverLeaveTimerRef = useRef<number | null>(null)

  // ── Expansion state ───────────────────────────────────────────────────────
  const [expanded, setExpanded] = useState(false)
  const [expansionTab, setExpansionTab] = useState<string>("backtranslation")

  // ── Compute attention signals for chevron + tab dots ──────────────────────
  const isBtStale = Boolean(
    cell.backtranslation && cell.backtranslationForText !== cell.translated,
  )
  const transcriptText = useMemo(() => {
    if (!cellAudioTimings || cellAudioTimings.length === 0) return ""
    return cellAudioTimings.map((t) => t.word).join(" ")
  }, [cellAudioTimings])
  const transcriptMatchesCellText = useMemo(() => {
    if (!hasAudio || !transcriptText) return true
    const norm = (s: string) =>
      s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").trim().replace(/\s+/g, " ")
    return norm(transcriptText) === norm(cell.translated)
  }, [hasAudio, transcriptText, cell.translated])
  const transcriptNeedsAttention =
    hasAudio &&
    Boolean(cellAudioTimings && cellAudioTimings.length > 0) &&
    !transcriptMatchesCellText
  const chevronAttentionDot: "red" | "amber" | "emerald" | "primary" | null =
    cellInfractions.length > 0
      ? hasMajorInfraction
        ? "red"
        : "amber"
      : isBtStale
        ? "amber"
        : transcriptNeedsAttention
          ? "amber"
          : null

  // First-open auto-tab: prefer the most-attention-worthy tab. Only applied
  // when the panel was closed and is being opened — once open, the user's
  // choice (or programmatic switches via inline rule clicks) wins.
  const previousExpandedRef = useRef(false)
  useEffect(() => {
    if (expanded && !previousExpandedRef.current) {
      const initial =
        cellInfractions.length > 0
          ? "issues"
          : transcriptNeedsAttention
            ? "audio"
            : "backtranslation"
      setExpansionTab(initial)
    }
    previousExpandedRef.current = expanded
  }, [expanded, cellInfractions.length, transcriptNeedsAttention])

  const railRevealed = isHovering || hasFocusWithin || isTapSelected || expanded

  // Stable rail handlers
  const handleRowMouseEnter = () => {
    if (hoverLeaveTimerRef.current !== null) {
      window.clearTimeout(hoverLeaveTimerRef.current)
      hoverLeaveTimerRef.current = null
    }
    setIsHovering(true)
  }
  const handleRowMouseLeave = () => {
    if (hoverLeaveTimerRef.current !== null) window.clearTimeout(hoverLeaveTimerRef.current)
    hoverLeaveTimerRef.current = window.setTimeout(() => {
      setIsHovering(false)
      hoverLeaveTimerRef.current = null
    }, 120)
  }
  const handleRowFocusCapture = () => setHasFocusWithin(true)
  const handleRowBlurCapture = (e: React.FocusEvent) => {
    const next = e.relatedTarget as Node | null
    if (next && rowRef.current?.contains(next)) return
    setHasFocusWithin(false)
  }
  const handleRowClick = (e: React.MouseEvent) => {
    // Cmd/Ctrl-click → toggle multi-select. Wins even over text editors and
    // buttons so the user can grab cells without aiming at a tiny gutter.
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault()
      e.stopPropagation()
      toggleSelected(cell.id)
      return
    }
    if (isInteractiveTarget(e.target)) return
    // Plain click clears any active multi-selection so the next interaction
    // doesn't surprise the user with a stale bulk action target.
    clearSelection()
    setIsTapSelected((p) => !p)
  }

  /**
   * Cmd/Ctrl-mousedown also has to be intercepted *before* the click — content-
   * editable surfaces (TipTap/ProseMirror) handle mousedown to place the
   * caret, and `preventDefault` on the later click event can't undo that. We
   * stop the gesture at mousedown when a modifier is held; the click handler
   * still fires and toggles the selection.
   */
  const handleRowMouseDownCapture = (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  // Inline rule click → open expansion to issues tab and remember which rule
  // (and which blot DOM node) is active so the ViolationPopover can anchor to
  // the blot directly rather than to a stray span at the bottom of the row.
  const openInlineRule = useCallback((ruleId: string, anchor: HTMLElement) => {
    setExpanded(true)
    setExpansionTab("issues")
    setOpenRuleId(ruleId)
    setOpenRuleAnchor(anchor)
  }, [])

  const [isVoiceDropTarget, setIsVoiceDropTarget] = useState(false)
  const handleRowDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes(VOICE_DRAG_MIME)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = "copy"
      if (!isVoiceDropTarget) setIsVoiceDropTarget(true)
    }
  }, [isVoiceDropTarget])
  const handleRowDragLeave = useCallback(() => {
    if (isVoiceDropTarget) setIsVoiceDropTarget(false)
  }, [isVoiceDropTarget])
  const handleRowDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const voiceId = e.dataTransfer.getData(VOICE_DRAG_MIME)
    if (!voiceId) return
    e.preventDefault()
    setIsVoiceDropTarget(false)
    void handleVoiceDropOnCell(cell.id, voiceId)
  }, [cell.id])

  const isMultiSelected = useIsSelected(cell.id)
  const synthStatus = useTtsStatus(ttsStatusKey(cell.id))
  const isSynthBusy = synthStatus.kind === "loading" || synthStatus.kind === "synthesizing"
  const isSynthError = synthStatus.kind === "error"

  return (
    <div className="border-b">
      <div
        ref={rowRef}
        className={cn(
          "group relative grid gap-2 px-4 py-2 transition-colors",
          audioController.isPlaying && "bg-primary/[0.04]",
          expanded && "bg-muted/10",
          isMultiSelected && "ring-2 ring-primary/40 ring-inset bg-primary/[0.03]",
          isVoiceDropTarget && "ring-2 ring-primary/70 ring-inset bg-primary/5",
          // Pulsing ring while a voice is being generated for this cell. Gives
          // the user a clear "something is happening" signal — drop, translate,
          // and bulk synth all flow through this status key.
          isSynthBusy && "ring-2 ring-primary/60 ring-inset bg-primary/[0.04] animate-pulse",
          isSynthError && "ring-2 ring-destructive/60 ring-inset bg-destructive/5",
          gridCols,
        )}
        onMouseEnter={handleRowMouseEnter}
        onMouseLeave={handleRowMouseLeave}
        onFocusCapture={handleRowFocusCapture}
        onBlurCapture={handleRowBlurCapture}
        onMouseDownCapture={handleRowMouseDownCapture}
        onClick={handleRowClick}
        onDragOver={handleRowDragOver}
        onDragLeave={handleRowDragLeave}
        onDrop={handleRowDrop}
      >
        {/* Severity stripe — absolutely positioned so layout (and vertical
            alignment with rows that have no issue) stays identical. */}
        {infractionCount > 0 && (
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-y-0 left-0 w-[3px]",
              hasMajorInfraction ? "bg-red-500/80" : "bg-amber-500/80",
            )}
          />
        )}

        {/* Left gutter — line number/label + validation pill. Selection lives
            on the source/target divider so range selection follows the text. */}
        <div className="flex flex-col items-center gap-1 pt-1">
          <div className="flex h-4 items-center gap-1 text-[10px] leading-none text-muted-foreground/60">
            {showLineNumber && (
              <span className="tabular-nums" title={`Line ${rowIndex + 1}`}>
                {rowIndex + 1}
              </span>
            )}
            {showCellLabel && (
              <span
                className="rounded bg-muted/50 px-1 py-0.5 font-medium text-muted-foreground/80"
                title="Cell label"
              >
                {cell.cellLabel}
              </span>
            )}
          </div>
          {(isSynthBusy || isSynthError) && (
            <SynthStatusBadge status={synthStatus} cellId={cell.id} />
          )}
          {validationButton}
        </div>

        {/* Source column */}
        <div
          className={cn(
            "flex flex-col transition-opacity",
            isSynthBusy && "opacity-70",
          )}
          dir={sourceTextDirection}
        >
          <div className="mb-1 flex items-center gap-1 text-xs text-muted-foreground" dir="ltr">
            <span>{cell.context}</span>
            {showFormattingLossWarning && (
              <span
                title="Source has inline formatting (bold, italic, etc.) that the target doesn't preserve. Formatting will be lost on export."
                className="inline-flex items-center gap-0.5 rounded bg-amber-100 px-1 py-0.5 text-[9px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-400"
              >
                <AlertTriangle className="h-2.5 w-2.5" />
                formatting
              </span>
            )}
          </div>
          {cell.originalHtml ? (
            <div
              className="text-sm"
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(cell.originalHtml) }}
            />
          ) : (
            <div className="text-sm">
              <HighlightedText
                text={cell.original}
                highlights={highlights}
                ranges={sourceRanges}
                showEvidence={examplesExpanded}
                onRangeClick={openInlineRule}
              />
            </div>
          )}
          {cellExamples.length > 0 && (
            <ExamplePanel
              examples={cellExamples}
              expanded={examplesExpanded}
              onExpandedChange={setExamplesExpanded}
            />
          )}
        </div>

        {/* Target column — TipTap is inline so typing is unchanged. Everything
            else (waveform, transcript preview, backtranslation, infractions
            detail) lives in the expansion panel. pr-9 reserves space for the
            ever-present chevron at the right edge. */}
        <div
          className={cn(
            "relative flex flex-col border-l border-border/50 pl-3 pr-9 transition-opacity",
            isSynthBusy && "opacity-70",
          )}
          dir={targetTextDirection}
        >
          <button
            type="button"
            role="checkbox"
            aria-checked={isMultiSelected}
            aria-label={isMultiSelected ? "Selected cell. Drag to extend selection." : "Select cell. Drag to select a range."}
            onPointerDown={onSelectionPointerDown}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "absolute left-0 top-1/2 z-20 grid h-5 w-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border shadow-sm",
              "touch-none cursor-ns-resize transition-[opacity,transform,color,background-color,border-color] duration-150 ease-out",
              "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2",
              isMultiSelected
                ? "border-primary bg-primary text-primary-foreground opacity-100"
                : "border-border bg-background text-muted-foreground/70 opacity-60 hover:border-primary hover:text-primary group-hover:opacity-100",
            )}
            title={isMultiSelected ? "Selected. Drag up or down to extend the range." : "Select cell. Drag up or down to select a range."}
          >
            {isMultiSelected ? (
              <Check className="h-3 w-3" strokeWidth={3} />
            ) : (
              <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
            )}
          </button>
          <div className="flex flex-1 flex-col">
            <div className="flex min-h-[40px] flex-1 flex-col">
              <TranslatedEditor
                cellId={cell.id}
                initialPlain={cell.translated}
                initialHtml={cell.translatedHtml}
                onCommit={handleEditorCommit}
                onFocus={handleEditorFocus}
                onBlur={handleEditorBlurOuter}
                className="w-full"
                editable={editable}
                heldByLabel={lockHolderLabel}
                infractions={[...cellInfractions, ...waivedInfractions]}
                ruleSeverity={ruleSeverity}
                waivedRuleIds={waivedRuleIds}
                onRuleClick={openInlineRule}
                audioTimings={cellAudioTimings}
                audioCurrentTime={hasAudio ? audioController.currentTime : undefined}
                onSeekToTime={hasAudio ? audioController.seek : undefined}
                remoteChangedDuringEdit={remoteChangedWhileFocused}
                onDiscardLocal={handleDiscardLocalAndReload}
              />
            </div>
            {error && <p className="mt-0.5 text-xs text-destructive">{error}</p>}
          </div>
        </div>

        {/* Floating action rail — anchored to the row's right edge. z-20 so
            it sits above the sticky column header (z-10). Without this, when
            a row is positioned at the very top of the scroll container, the
            sticky header's stacking context wins (rows are position:relative
            with auto z-index, so the row's local z-10 doesn't escape the
            sticky header's z-10 context). */}
        <div className="pointer-events-none absolute right-2 top-1.5 z-20 flex">
          <div className="pointer-events-auto">
            <CellActionRail
              revealed={railRevealed}
              expanded={expanded}
              onToggleExpanded={() => setExpanded((p) => !p)}
              alwaysShowChevron
              expansionAttentionDot={chevronAttentionDot}
            >
              <RailButton
                icon={<Sparkles className="h-3.5 w-3.5" />}
                tooltip={
                  isAnonymous
                    ? "Sign in for AI translations"
                    : !editable
                      ? "Read-only (imported from git)"
                      : !isCompletionConfigured
                        ? "Set up AI to enable"
                        : !isCompletionAvailable
                          ? "AI service unavailable — try again shortly"
                          : isLoading
                            ? "Generating…"
                            : "Generate translation"
                }
                onClick={() => {
                  if (isLoading) return
                  if (!isCompletionConfigured && editable && !isAnonymous) {
                    onAiSetupNeeded?.()
                    return
                  }
                  if (
                    isCompletionConfigured &&
                    isCompletionAvailable &&
                    editable &&
                    !isAnonymous
                  ) {
                    onCompleteSingle(cell)
                  }
                }}
                disabled={
                  (!isCompletionConfigured && !onAiSetupNeeded) ||
                  !isCompletionAvailable ||
                  !editable ||
                  isAnonymous ||
                  isLoading
                }
                pulsing={isLoading}
                onMouseDown={onDragStart}
                onMouseEnter={onDragEnter}
              />

              {hasAudio ? (
                <RailButton
                  icon={
                    audioController.isPlaying ? (
                      <Pause className="h-3.5 w-3.5" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )
                  }
                  tooltip={audioController.isPlaying ? "Pause" : "Play audio"}
                  onClick={() => {
                    if (audioController.state === "loading") return
                    if (audioController.isPlaying) audioController.pause()
                    else void audioController.play()
                  }}
                  disabled={audioController.state === "loading"}
                  toneClass={
                    audioController.isPlaying
                      ? "text-primary hover:text-primary"
                      : undefined
                  }
                />
              ) : (
                <RailButton
                  icon={
                    !editable ? (
                      <MicOff className="h-3.5 w-3.5" />
                    ) : (
                      <Mic className="h-3.5 w-3.5" />
                    )
                  }
                  tooltip={
                    !editable
                      ? "Read-only"
                      : !onOpenRecording
                        ? "Recording disabled"
                        : "Record audio"
                  }
                  onClick={() => onOpenRecording?.(cell.id)}
                  disabled={!editable || !onOpenRecording}
                />
              )}

              {cell.translated.trim().length > 0 && (
                <CellTtsButton
                  cellId={cell.id}
                  text={cell.translated}
                  original={cell.original}
                  context={cell.context}
                  cellLabel={cell.cellLabel}
                  sourceLanguage={project.sourceLanguage}
                  targetLanguage={project.targetLanguage}
                  projectTtsSettings={project.ttsSettings}
                  cellTtsSettings={cell.ttsSettings}
                  generatedVoiceAudioId={cell.selectedGeneratedVoiceAudioId}
                  attachments={cell.attachments}
                  projectId={project.id}
                  fileId={cell.fileId}
                  disabled={!editable}
                />
              )}

              {onOpenComments && (
                <RailButton
                  icon={<MessageCircle className="h-3.5 w-3.5" />}
                  tooltip={
                    openCommentCount > 0
                      ? `${openCommentCount} open comment${openCommentCount !== 1 ? "s" : ""}`
                      : "Add comment"
                  }
                  onClick={() => onOpenComments(cell.id)}
                  toneClass={
                    openCommentCount > 0
                      ? "text-primary hover:text-primary"
                      : undefined
                  }
                  dot={openCommentCount > 0 ? "primary" : undefined}
                />
              )}

              {onSeekToCue && (
                <RailButton
                  icon={<Play className="h-3.5 w-3.5" />}
                  tooltip="Play from this cue"
                  onClick={() => onSeekToCue(cell.id)}
                />
              )}
            </CellActionRail>
          </div>
        </div>
      </div>

      {/* Expansion panel — hosts the rich, lower-frequency context that used
          to clutter the inline row: health breakdown, backtranslation, audio
          waveform + transcript, infractions detail, edit history. */}
      <div className="px-4 pb-2">
        <CellExpansion
          open={expanded}
          tab={expansionTab}
          onTabChange={setExpansionTab}
          onClose={() => setExpanded(false)}
          tabs={[
            {
              value: "health",
              icon: <Activity className="h-3 w-3" />,
              label: "Decay",
              content: (
                <div className="space-y-1.5 py-3 text-xs text-muted-foreground">
                  <p>
                    <span className="font-medium text-foreground">{cell.endorsementCount ?? 0}</span>
                    {" "}endorsement{(cell.endorsementCount ?? 0) === 1 ? "" : "s"} · health{" "}
                    <span className="font-medium text-foreground">{healthValue}%</span>
                  </p>
                  <p>
                    {cellNeedsAttention
                      ? "Needs attention — this cell's retrieval neighborhood hasn't been validated yet (AD-14)."
                      : "No attention needed — enough of this cell's neighborhood is validated."}
                  </p>
                </div>
              ),
            },
            {
              value: "backtranslation",
              icon: <FileText className="h-3 w-3" />,
              label: "Backtranslation",
              attentionDot: isBtStale ? "amber" : undefined,
              content: (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <h4 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      Backtranslation
                    </h4>
                    <button
                      type="button"
                      onClick={() => onBacktranslate?.(cell)}
                      disabled={
                        !isBacktranslationConfigured ||
                        isBacktranslating ||
                        !editable ||
                        cell.translated.trim().length === 0
                      }
                      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                      title={
                        !editable
                          ? "Read-only (imported from git)"
                          : !isBacktranslationConfigured
                            ? "Set up AI for backtranslation"
                            : cell.backtranslation
                              ? "Regenerate backtranslation"
                              : "Generate backtranslation"
                      }
                    >
                      <RefreshCw
                        className={cn("h-3 w-3", isBacktranslating && "animate-spin")}
                      />
                      {cell.backtranslation ? "Regenerate" : "Generate"}
                    </button>
                  </div>

                  {cell.backtranslation ? (
                    <div className="rounded border border-border/40 bg-background/40 px-3 py-2 text-sm italic text-muted-foreground">
                      {isBtStale && (
                        <div className="mb-1 inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium not-italic text-amber-700 dark:text-amber-400">
                          <AlertTriangle className="h-2.5 w-2.5" />
                          Stale — translation has changed
                        </div>
                      )}
                      <div className="leading-relaxed">{cell.backtranslation}</div>
                    </div>
                  ) : (
                    <p className="rounded border border-dashed border-border/60 px-3 py-3 text-center text-xs text-muted-foreground">
                      {cell.translated.trim().length === 0
                        ? "Add a translation first, then generate a backtranslation."
                        : "No backtranslation yet. Click Generate to create one."}
                    </p>
                  )}
                  {backtranslationError && (
                    <p className="text-xs text-destructive">{backtranslationError}</p>
                  )}
                </div>
              ),
            },
            {
              value: "audio",
              icon: <Mic className="h-3 w-3" />,
              label: "Recording",
              attentionDot: transcriptNeedsAttention
                ? "amber"
                : (hasAudio || hasGeneratedVoice)
                  ? "emerald"
                  : undefined,
              content: (
                <div className="flex flex-col gap-3">
                  {hasAudio ? (
                    <>
                      <div className="flex items-center gap-2">
                        <CellAudioButton controller={audioController} />
                        <div className="flex-1">
                          <CellWaveform
                            controller={audioController}
                            height={36}
                            strategy={project.audioMediaStrategy ?? "lazy"}
                          />
                        </div>
                      </div>
                      {cellAudioTimings && cellAudioTimings.length > 0 && (
                        <CellTranscriptPreview
                          ref={transcriptPreviewRef}
                          timings={cellAudioTimings}
                          cellText={cell.translated}
                          cellId={cell.id}
                          alignedToCellText={
                            tokenizeWords(cell.translated).length === cellAudioTimings.length
                          }
                          editable={editable}
                          onRetranscribe={handleTranscribe}
                        />
                      )}
                      <div className="flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          onClick={() => onOpenRecording?.(cell.id)}
                          disabled={!editable || !onOpenRecording}
                          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Mic className="h-3 w-3" />
                          Re-record
                        </button>
                        <button
                          type="button"
                          onClick={handleTranscribe}
                          disabled={!editable || isTranscribing}
                          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Sparkles
                            className={cn(
                              "h-3 w-3",
                              isTranscribing && "animate-pulse",
                            )}
                          />
                          {isTranscribing ? "Transcribing…" : "Transcribe"}
                        </button>
                      </div>
                    </>
                  ) : hasGeneratedVoice ? (
                    <>
                      <div className="flex items-center gap-2">
                        <CellAudioButton controller={generatedVoiceController} />
                        <div className="flex-1">
                          <CellWaveform
                            controller={generatedVoiceController}
                            height={36}
                            strategy={project.audioMediaStrategy ?? "lazy"}
                          />
                        </div>
                      </div>
                      {generatedVoiceTimings && generatedVoiceTimings.length > 0 && (
                        <CellTranscriptPreview
                          timings={generatedVoiceTimings}
                          cellText={cell.translated}
                          cellId={cell.id}
                          alignedToCellText={
                            tokenizeWords(cell.translated).length === generatedVoiceTimings.length
                          }
                          editable={editable}
                        />
                      )}
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] text-muted-foreground">AI generated voice. Drag a voice from the toolbar to regenerate, or:</span>
                        <button
                          type="button"
                          onClick={() => onOpenRecording?.(cell.id)}
                          disabled={!editable || !onOpenRecording}
                          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Mic className="h-3 w-3" />
                          Record over
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-col items-center gap-3 py-4 text-center">
                      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted/40 text-muted-foreground/50">
                        <Mic className="h-5 w-5" />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        No audio yet. Record below, or drag a voice onto this cell from the toolbar above.
                      </p>
                      <div className="flex flex-wrap items-center justify-center gap-2">
                        <button
                          type="button"
                          onClick={() => onOpenRecording?.(cell.id)}
                          disabled={!editable || !onOpenRecording}
                          className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                          title="Record audio"
                        >
                          <Mic className="h-3 w-3" />
                          Record
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ),
            },
            {
              value: "issues",
              icon: <AlertTriangle className="h-3 w-3" />,
              label: "Issues",
              attentionDot:
                cellInfractions.length > 0
                  ? hasMajorInfraction
                    ? "red"
                    : "amber"
                  : undefined,
              disabled: cellInfractions.length === 0 && waivedInfractions.length === 0,
              content: (
                <div className="flex flex-col gap-1.5">
                  {cellInfractions.length === 0 && waivedInfractions.length === 0 ? (
                    <p className="py-3 text-center text-xs text-muted-foreground">
                      No translation rule issues on this cell.
                    </p>
                  ) : (
                    <>
                      {cellInfractions.map((inf) => {
                        const rule = ruleMap.get(inf.ruleId)
                        const isMajor = rule?.severity === "major"
                        const Icon = isMajor ? AlertTriangle : AlertCircle
                        return (
                          <button
                            key={inf.ruleId}
                            type="button"
                            onClick={() => setOpenRuleId(inf.ruleId)}
                            className="flex w-full items-start gap-2 rounded border border-border/40 bg-background/40 px-2.5 py-2 text-left text-xs transition-colors hover:bg-muted/40"
                          >
                            <Icon
                              className={cn(
                                "mt-0.5 h-3 w-3 shrink-0",
                                isMajor ? "text-red-500" : "text-amber-500",
                              )}
                            />
                            <span className="flex-1">
                              <span className="font-medium text-foreground">
                                {rule?.name ?? inf.ruleId}
                              </span>
                              <span className="ml-1 text-muted-foreground">
                                — {inf.message}
                              </span>
                            </span>
                            <ArrowRight className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/50" />
                          </button>
                        )
                      })}
                      {waivedInfractions.length > 0 && (
                        <>
                          <div className="mt-2 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            Waived
                          </div>
                          {waivedInfractions.map((inf) => {
                            const rule = ruleMap.get(inf.ruleId)
                            return (
                              <button
                                key={`waived-${inf.ruleId}`}
                                type="button"
                                onClick={() => setOpenRuleId(inf.ruleId)}
                                className="flex w-full items-start gap-2 rounded border border-border/30 bg-background/20 px-2.5 py-1.5 text-left text-xs text-muted-foreground/70 transition-colors hover:bg-muted/30"
                              >
                                <Check className="mt-0.5 h-3 w-3 shrink-0" />
                                <span className="flex-1">
                                  {rule?.name ?? inf.ruleId}
                                </span>
                              </button>
                            )
                          })}
                        </>
                      )}
                    </>
                  )}
                </div>
              ),
            },
            {
              value: "history",
              icon: <HistoryIcon className="h-3 w-3" />,
              label: "History",
              disabled: cell.history.length === 0,
              content: (
                <div className="flex flex-col gap-2">
                  {cell.history.length === 0 ? (
                    <p className="py-3 text-center text-xs text-muted-foreground">
                      No edit history yet.
                    </p>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => onOpenHistory?.(cell.id)}
                        disabled={!onOpenHistory}
                        className="self-start inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <HistoryIcon className="h-3 w-3" />
                        Open full history
                      </button>
                      <ul className="divide-y divide-border/40 rounded border border-border/40 bg-background/40">
                        {[...cell.history].slice(-5).reverse().map((entry, i) => {
                          const date = new Date(entry.timestamp).toLocaleString(undefined, {
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          })
                          return (
                            <li key={`${entry.timestamp}-${i}`} className="px-2.5 py-1.5 text-xs">
                              <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-muted-foreground/80">
                                <span>{entry.author}</span>
                                <span>{date}</span>
                              </div>
                              <div className="mt-0.5 truncate italic text-muted-foreground">
                                "{entry.value}"
                              </div>
                            </li>
                          )
                        })}
                      </ul>
                    </>
                  )}
                </div>
              ),
            },
          ]}
        />
      </div>

      {openRuleId && (() => {
        const inf = [...cellInfractions, ...waivedInfractions].find(
          (i) => i.ruleId === openRuleId,
        )
        const rule = ruleMap.get(openRuleId)
        if (!inf || !rule) return null
        return (
          <ViolationPopover
            open
            onOpenChange={(next) => {
              if (!next) {
                setOpenRuleId(null)
                setOpenRuleAnchor(null)
              }
            }}
            infraction={inf}
            ruleName={rule.name}
            waivers={cell.waivers ?? []}
            anchor={openRuleAnchor}
            onOpenRule={(ruleId) => {
              setOpenRuleId(null)
              setOpenRuleAnchor(null)
              onInfractionClick?.(ruleId)
            }}
            onWaive={handleWaive}
            onUnwaive={handleUnwaive}
          />
        )
      })()}
    </div>
  )
}
