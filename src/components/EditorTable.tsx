import React, { useEffect, useRef, useCallback, useMemo, useState, forwardRef, useImperativeHandle } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import * as Y from "yjs"
import DOMPurify from "dompurify"
import {
  Check, CheckCheck, Circle, Trash2, AlertTriangle, AlertCircle, RefreshCw,
  MessageCircle, Play, Pause, Mic, MicOff, Sparkles, FileText, History as HistoryIcon,
  ArrowRight, Activity,
} from "lucide-react"
import type { CellData } from "@/hooks/useCells"
import type { ScoredPair } from "@/lib/search/dual-index"
import type { TranslationRule, RuleInfraction, ProjectRecord, CellHealthBreakdown } from "@/lib/parsers/types"
import { useProjectPermissions } from "@/hooks/useProjectPermissions"
import { appendCellHistory, recordHistoryEntry, toggleCellValidation } from "@/hooks/useCellHistory"
import { commitCellEdit } from "@/lib/codex-editor/edits/commit-cell-edit"
import { getPlainText, getFragmentHtml } from "@/lib/richtext/translated-xml"
import { ExamplePanel } from "./ExamplePanel"
import { HighlightedText, buildHighlightsFromExamples } from "./HighlightedText"
import { HealthRing } from "./HealthRing"
import { HealthBreakdown } from "./HealthBreakdown/HealthBreakdown"
import { BreakdownContent } from "./HealthBreakdown/BreakdownContent"
import { TranslatedEditor } from "./TranslatedEditor"
import { CellWaveform } from "./CellWaveform"
import { CellAudioButton } from "./CellAudioButton"
import { CellTtsButton } from "./CellTtsButton"
import { CellTranscriptPreview } from "./CellTranscriptPreview"
import { CellActionRail, RailButton, isInteractiveTarget } from "./CellActionRail"
import { CellExpansion } from "./CellExpansion"
import { tokenizeWords } from "@/lib/audio/timings"
import { useCellAudio } from "@/hooks/useCellAudio"
import { transcribeAndStoreTimings } from "@/lib/audio/transcribe"
import { setTranscribeStatus, useTranscribeStatus } from "@/lib/audio/transcribe-status"
import { whisperLanguageFromTag } from "@/lib/audio/language"
import { handleVoiceDropOnCell, VOICE_DRAG_MIME } from "./VoiceBar"
import { AiModelConsentDeniedError } from "@/lib/audio/ai-consent"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { isPerfLogEnabled } from "@/lib/perf-log"
import { partitionInfractions, addWaiver, removeWaiver } from "@/lib/rules/waivers"
import { setCellWaivers } from "@/hooks/useCellWaivers"
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

function ValidationHistoryTimeline({
  entries, currentUsername,
}: {
  entries: import("@/lib/codex-editor/edits/types").EditValidationSummary[]
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

export interface EditorTableHandle {
  scrollToCellIndex: (index: number) => void
  getCurrentIndex?: () => number
}

interface EditorTableProps {
  project: ProjectRecord
  cells: CellData[]
  doc: Y.Doc
  username: string
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
  syncProvider?: import("y-partyserver/provider").default | null
  collabUser?: { name: string; color: string }
  activeCueIndex?: number
  onSeekToCue?: (cellId: string) => void
  lineNumbersEnabled: boolean
  cellLabelsEnabled: boolean
  sourceTextDirection: "ltr" | "rtl"
  targetTextDirection: "ltr" | "rtl"
  isAnonymous?: boolean
  breakdownMap?: Map<string, CellHealthBreakdown>
  onJumpToCell?: (cellId: string) => void
  /** Called when user clicks a disabled sparkle while AI is not yet configured. */
  onAiSetupNeeded?: () => void
  /** Called when the user clicks the mic button on a cell. The parent owns
   *  the recording modal so it can persist across cell navigation. */
  onOpenRecording?: (cellId: string) => void
  /** Re-read the project record from IDB after a settings change (e.g. voice library edits). */
  onProjectChanged?: () => void
}

export const EditorTable = forwardRef<EditorTableHandle, EditorTableProps>(function EditorTable({
  project, cells, doc, username, isCompletionConfigured, isCompletionAvailable,
  completing, examples, errors,
  onCompleteSingle, onCompleteBatch, healthMap,
  infractions = new Map(), rules = [], onInfractionClick,
  isBacktranslationConfigured, onBacktranslate, backtranslating, backtranslationErrors,
  cellOpenCommentCount, onOpenComments, onOpenHistory,
  syncProvider, collabUser,
  activeCueIndex, onSeekToCue,
  lineNumbersEnabled, cellLabelsEnabled, sourceTextDirection, targetTextDirection,
  isAnonymous, breakdownMap, onJumpToCell, onAiSetupNeeded, onOpenRecording,
  onProjectChanged,
}, ref) {
  const permissions = useProjectPermissions(project)
  const canEdit = permissions.canEditContent
  const parentRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)
  const dragCells = useRef<Set<string>>(new Set())
  const cellsRef = useRef(cells)

  useEffect(() => {
    cellsRef.current = cells
  }, [cells])

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
  }), [virtualizer, cells.length])

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
          const cell = cells[virtualRow.index]
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
                doc={doc}
                username={username}
                editable={canEdit}
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
                syncProvider={syncProvider}
                collabUser={collabUser}
                activeCueIndex={activeCueIndex}
                onSeekToCue={onSeekToCue}
                rowIndex={virtualRow.index}
                lineNumbersEnabled={lineNumbersEnabled}
                cellLabelsEnabled={cellLabelsEnabled}
                sourceTextDirection={sourceTextDirection}
                targetTextDirection={targetTextDirection}
                gridCols={gridCols}
                isAnonymous={isAnonymous}
                breakdownMap={breakdownMap}
                onJumpToCell={onJumpToCell}
                onAiSetupNeeded={onAiSetupNeeded}
                onOpenRecording={onOpenRecording}
                onProjectChanged={onProjectChanged}
                onDragStart={handleDragStart}
                onDragEnter={handleDragEnter}
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
  doc: Y.Doc
  username: string
  editable: boolean
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
  syncProvider?: import("y-partyserver/provider").default | null
  collabUser?: { name: string; color: string }
  activeCueIndex?: number
  onSeekToCue?: (cellId: string) => void
  rowIndex: number
  lineNumbersEnabled: boolean
  cellLabelsEnabled: boolean
  sourceTextDirection: "ltr" | "rtl"
  targetTextDirection: "ltr" | "rtl"
  gridCols: "grid-cols-[44px_1fr_1fr]"
  isAnonymous?: boolean
  breakdownMap?: Map<string, CellHealthBreakdown>
  onJumpToCell?: (cellId: string) => void
  onAiSetupNeeded?: () => void
  onOpenRecording?: (cellId: string) => void
  onProjectChanged?: () => void
  onDragStart: (cellId: string) => void
  onDragEnter: (cellId: string) => void
  getVoiceTakeCells: (startIndex: number, count: number) => CellData[]
}

const MemoizedRow = React.memo(function MemoizedRow(props: MemoizedRowProps) {
  const {
    cell, examples, completing, errors, healthMap, infractions,
    backtranslating, backtranslationErrors, cellOpenCommentCount, breakdownMap,
    activeCueIndex, rowIndex, gridCols,
    onDragStart: onDragStartParent, onDragEnter: onDragEnterParent,
    getVoiceTakeCells,
    project, doc, username, editable, isCompletionConfigured, isCompletionAvailable,
    ruleMap, onCompleteSingle, onInfractionClick,
    isBacktranslationConfigured, onBacktranslate,
    onOpenComments, onOpenHistory, syncProvider, collabUser,
    onSeekToCue, lineNumbersEnabled, cellLabelsEnabled,
    sourceTextDirection, targetTextDirection, isAnonymous,
    onJumpToCell, onAiSetupNeeded, onOpenRecording, onProjectChanged,
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
  const breakdown = breakdownMap?.get(cellId)
  const isActiveCue = activeCueIndex !== undefined && activeCueIndex === rowIndex

  // Bind the stable parent (cellId) => void handlers to this row's cellId.
  // Stable per-row because both parent callbacks and cellId are stable.
  const handleDragStart = useCallback(() => onDragStartParent(cellId), [onDragStartParent, cellId])
  const handleDragEnter = useCallback(() => onDragEnterParent(cellId), [onDragEnterParent, cellId])

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
        doc={doc}
        username={username}
        editable={editable}
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
        syncProvider={syncProvider}
        collabUser={collabUser}
        isActiveCue={isActiveCue}
        onSeekToCue={onSeekToCue}
        rowIndex={rowIndex}
        lineNumbersEnabled={lineNumbersEnabled}
        cellLabelsEnabled={cellLabelsEnabled}
        sourceTextDirection={sourceTextDirection}
        targetTextDirection={targetTextDirection}
        gridCols={gridCols}
        isAnonymous={isAnonymous}
        breakdown={breakdown}
        onJumpToCell={onJumpToCell}
        onAiSetupNeeded={onAiSetupNeeded}
        onOpenRecording={onOpenRecording}
        onProjectChanged={onProjectChanged}
        onDragStart={handleDragStart}
        onDragEnter={handleDragEnter}
        getVoiceTakeCells={getVoiceTakeCells}
      />
    </div>
  )
})

interface EditorRowProps {
  project: ProjectRecord
  cell: CellData
  doc: Y.Doc
  username: string
  editable: boolean
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
  syncProvider?: import("y-partyserver/provider").default | null
  collabUser?: { name: string; color: string }
  isActiveCue?: boolean
  onSeekToCue?: (cellId: string) => void
  onDragStart: () => void
  onDragEnter: () => void
  getVoiceTakeCells: (startIndex: number, count: number) => CellData[]
  rowIndex: number
  lineNumbersEnabled: boolean
  cellLabelsEnabled: boolean
  sourceTextDirection: "ltr" | "rtl"
  targetTextDirection: "ltr" | "rtl"
  gridCols: "grid-cols-[44px_1fr_1fr]"
  isAnonymous?: boolean
  breakdown?: CellHealthBreakdown
  onJumpToCell?: (cellId: string) => void
  onAiSetupNeeded?: () => void
  onOpenRecording?: (cellId: string) => void
  onProjectChanged?: () => void
}

function EditorRow({
  project, cell, doc, username, editable, isCompletionConfigured, isCompletionAvailable, isLoading,
  cellExamples, highlights, error, health,
  cellInfractions, waivedInfractions, ruleMap,
  onCompleteSingle, onInfractionClick,
  isBacktranslationConfigured, isBacktranslating, backtranslationError, onBacktranslate,
  openCommentCount, onOpenComments, onOpenHistory,
  syncProvider, collabUser,
  isActiveCue: _isActiveCue, onSeekToCue,
  onDragStart, onDragEnter,
  rowIndex, lineNumbersEnabled, cellLabelsEnabled, sourceTextDirection, targetTextDirection, gridCols,
  isAnonymous, breakdown, onJumpToCell, onAiSetupNeeded, onOpenRecording,
}: EditorRowProps) {
  const [openRuleId, setOpenRuleId] = useState<string | null>(null)
  const [openRuleAnchor, setOpenRuleAnchor] = useState<HTMLElement | null>(null)
  const [examplesExpanded, setExamplesExpanded] = useState(false)

  const ruleSeverity = useMemo(() => {
    const m = new Map<string, "major" | "minor">()
    for (const [id, rule] of ruleMap) m.set(id, rule.severity)
    return m
  }, [ruleMap])

  const waivedRuleIds = useMemo(
    () => new Set((cell.waivers ?? []).map((w) => w.ruleId)),
    [cell.waivers],
  )

  const handleWaive = useCallback((input: { ruleId: string; reason?: string }) => {
    const next = addWaiver(cell.waivers ?? [], input, username)
    setCellWaivers(doc, cell.id, next)
    setOpenRuleId(null)
  }, [cell.waivers, cell.id, doc, username])

  const handleUnwaive = useCallback((ruleId: string) => {
    const next = removeWaiver(cell.waivers ?? [], ruleId)
    setCellWaivers(doc, cell.id, next)
    setOpenRuleId(null)
  }, [cell.waivers, cell.id, doc])

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

  const targetRanges = useMemo<RangeHighlight[]>(() => {
    // Target side is handled by the ProseMirror plugin inside TranslatedEditor
    // when the cell has a translatedXml fragment. Only produce ranges for the
    // plain-textarea fallback case.
    if (cell.translatedXml) return []
    const out: RangeHighlight[] = []
    const all = [...cellInfractions, ...waivedInfractions]
    for (const inf of all) {
      const waived = waivedRuleIds.has(inf.ruleId)
      const severity = ruleSeverity.get(inf.ruleId) ?? "major"
      for (const span of inf.spans) {
        if (span.side !== "target") continue
        out.push({
          start: span.start, end: span.end, ruleId: inf.ruleId,
          kind: waived ? "violation-waived" : (severity === "major" ? "violation-major" : "violation-minor"),
        })
      }
    }
    return out
  }, [cellInfractions, waivedInfractions, waivedRuleIds, ruleSeverity, cell.translatedXml])

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    appendCellHistory(doc, cell.id, {
      value: e.target.value,
      source: "human",
      author: username,
      validated: true,
    })
  }

  // Called when the TipTap editor loses focus. Capture the current fragment
  // text and append a history entry if it differs meaningfully from the most
  // recent entry. Focus-triggered (not keystroke-triggered) so each editing
  // session produces at most one entry regardless of typing length.
  function handleEditorBlur() {
    const cellsMap = doc.getMap("cells")
    const yCell = cellsMap.get(cell.id) as Y.Map<unknown> | undefined
    if (!yCell) return
    const frag = yCell.get("translatedXml") as Y.XmlFragment | undefined
    if (!frag) return
    const currentText = getPlainText(frag)
    const lastEntry = cell.history[cell.history.length - 1]

    // Don't record a no-op empty
    if (!currentText.trim() && cell.history.length === 0) return
    if (lastEntry && lastEntry.value === currentText) return

    // Collapse rapid same-author edits: if the last entry is from the same
    // author within the past 5 seconds and the text changed only slightly,
    // OVERWRITE the last entry's value/timestamp in place instead of appending
    // a new one. This guards against accidental rapid blur/focus cycles that
    // would otherwise spam history.
    if (
      lastEntry &&
      lastEntry.author === username &&
      lastEntry.source === "human" &&
      Date.now() - new Date(lastEntry.timestamp).getTime() < 5_000
    ) {
      // Update the last entry by removing + re-adding (Y.Array doesn't have set)
      const historyArr = yCell.get("history") as Y.Array<import("@/lib/parsers/types").CellHistoryEntry> | undefined
      if (historyArr && historyArr.length > 0) {
        doc.transact(() => {
          historyArr.delete(historyArr.length - 1, 1)
          historyArr.push([{
            value: currentText,
            source: "human",
            author: username,
            validated: true,
            timestamp: new Date().toISOString(),
          }])
        })
        commitCellEdit(doc, cell.id, username, ["value"], currentText, "human")
        return
      }
    }

    recordHistoryEntry(doc, cell.id, {
      value: currentText,
      source: "human",
      author: username,
      validated: true,
    })
    // Dual write: cell.edits is the Yjs-native source of truth for validation;
    // cell.history keeps feeding the TipTap binding.
    commitCellEdit(doc, cell.id, username, ["value"], currentText, "human")
  }

  // Detect formatting loss: source has inline style marks that the target doesn't.
  const sourceHasFormatting = Boolean(cell.originalHtml && /<(b|strong|i|em|u|s|strike|del|code)\b/i.test(cell.originalHtml))
  const targetHtml = cell.translatedXml ? getFragmentHtml(cell.translatedXml) : ""
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
  const audioController = useCellAudio(project, cellForAudio)
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
  const generatedVoiceController = useCellAudio(project, cellForGeneratedVoice)

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
    const audioId = cell.selectedAudioId
    if (!audioId) return
    setTranscribeStatus(audioId, { kind: "loading", loaded: 0, total: 0, file: "" })
    const startedAt = Date.now()
    try {
      const bytes = await audioController.ensureBytes()
      const out = await transcribeAndStoreTimings(doc, cell.id, audioId, bytes, {
        cellText: cell.translated,
        language: whisperLanguageFromTag(project.targetLanguage),
        onProgress: (p) => {
          setTranscribeStatus(audioId, { kind: "loading", loaded: p.loaded, total: p.total, file: p.file })
          if (p.status === "ready" || (p.total > 0 && p.loaded >= p.total)) {
            setTranscribeStatus(audioId, { kind: "transcribing" })
          }
        },
      })
      setTranscribeStatus(audioId, {
        kind: "done", wordCount: out.timings.length, durationMs: Date.now() - startedAt,
      })
    } catch (e) {
      if (e instanceof AiModelConsentDeniedError) {
        setTranscribeStatus(audioId, { kind: "idle" })
        return
      }
      setTranscribeStatus(audioId, {
        kind: "error", message: e instanceof Error ? e.message : String(e),
      })
    }
  }, [cell.id, cell.selectedAudioId, cell.translated, audioController, doc, project.targetLanguage])

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
        toggleCellValidation(doc, cell.id, username, true)
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
            <HealthRing health={healthValue} size={18} strokeWidth={2}>
              <ValidationIcon
                className="h-3 w-3"
                strokeWidth={2.5}
                {...(vs === "others" ? { fill: "currentColor" } : {})}
              />
            </HealthRing>
          </button>
        }
      />
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
                        toggleCellValidation(doc, cell.id, username, false)
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
    {breakdown && (
      <HealthBreakdown
        breakdown={breakdown}
        scopeLabel="cell health"
        onCellClick={onJumpToCell}
        majorInfractionCount={breakdown.signals.infractions.length}
      >
        <span className="sr-only">Breakdown</span>
      </HealthBreakdown>
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
  const hasGutterMetadata = showLineNumber || showCellLabel
  const isGitProject = project.origin?.kind === "git"

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
    // Tap on a non-interactive area toggles tap-selected (touch users get
    // persistent rail visibility). Clicks on buttons / inputs / contentEditable
    // pass through.
    if (!isInteractiveTarget(e.target)) {
      setIsTapSelected((p) => !p)
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

  return (
    <div className="border-b">
      <div
        ref={rowRef}
        className={cn(
          "group relative grid gap-2 px-4 py-2 transition-colors",
          audioController.isPlaying && "bg-primary/[0.04]",
          expanded && "bg-muted/10",
          isVoiceDropTarget && "ring-2 ring-primary/60 ring-inset bg-primary/5",
          gridCols,
        )}
        onMouseEnter={handleRowMouseEnter}
        onMouseLeave={handleRowMouseLeave}
        onFocusCapture={handleRowFocusCapture}
        onBlurCapture={handleRowBlurCapture}
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

        {/* Left gutter — line number + cell label + validation pill. */}
        <div className="flex flex-col items-center gap-1.5 pt-1">
          {hasGutterMetadata && (
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
          )}
          <div className={hasGutterMetadata ? "" : "pt-3"}>{validationButton}</div>
        </div>

        {/* Source column */}
        <div className="flex flex-col" dir={sourceTextDirection}>
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
        <div className="flex flex-col border-l border-border/50 pl-3 pr-9" dir={targetTextDirection}>
          <div className="flex flex-1 flex-col">
            {cell.translatedXml ? (
              <div className="flex min-h-[40px] flex-1 flex-col">
                <TranslatedEditor
                  fragment={cell.translatedXml}
                  className="w-full"
                  syncProvider={syncProvider}
                  user={collabUser}
                  onBlur={handleEditorBlur}
                  editable={editable}
                  infractions={[...cellInfractions, ...waivedInfractions]}
                  ruleSeverity={ruleSeverity}
                  waivedRuleIds={waivedRuleIds}
                  onRuleClick={openInlineRule}
                  audioTimings={cellAudioTimings}
                  audioCurrentTime={hasAudio ? audioController.currentTime : undefined}
                  onSeekToTime={hasAudio ? audioController.seek : undefined}
                />
              </div>
            ) : (
              <div className="relative flex min-h-[40px] flex-1 flex-col">
                <textarea
                  className="w-full flex-1 resize-none rounded-sm bg-transparent px-2 py-1 text-sm leading-relaxed transition-colors hover:bg-muted/40 focus:bg-muted/30 focus:outline-none disabled:cursor-not-allowed disabled:opacity-70"
                  value={cell.translated}
                  onChange={handleChange}
                  readOnly={!editable}
                  rows={Math.max(2, Math.ceil(cell.original.length / 50))}
                />
                {targetRanges.length > 0 && (
                  <div
                    className="pointer-events-none absolute inset-0 whitespace-pre-wrap break-words px-2 py-1 text-sm"
                    aria-hidden
                  >
                    <HighlightedText text={cell.translated} ranges={targetRanges} />
                  </div>
                )}
              </div>
            )}
            {error && <p className="mt-0.5 text-xs text-destructive">{error}</p>}
          </div>
        </div>

        {/* Floating action rail — anchored to the row's right edge. */}
        <div className="pointer-events-none absolute right-2 top-1.5 z-10 flex">
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
                    !editable || isGitProject ? (
                      <MicOff className="h-3.5 w-3.5" />
                    ) : (
                      <Mic className="h-3.5 w-3.5" />
                    )
                  }
                  tooltip={
                    isGitProject
                      ? "Recording on GitLab projects isn't available yet"
                      : !editable
                        ? "Read-only (imported from git)"
                        : !onOpenRecording
                          ? "Recording disabled"
                          : "Record audio"
                  }
                  onClick={() => onOpenRecording?.(cell.id)}
                  disabled={!editable || !onOpenRecording || isGitProject}
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
              label: "Health",
              disabled: !breakdown,
              content: breakdown ? (
                <BreakdownContent
                  breakdown={breakdown}
                  scopeLabel="cell health"
                  onCellClick={onJumpToCell}
                  majorInfractionCount={cellInfractions.filter(
                    (i) => ruleMap.get(i.ruleId)?.severity === "major",
                  ).length}
                  variant="inline"
                />
              ) : (
                <p className="py-3 text-center text-xs text-muted-foreground">
                  Composite health is off — turn it on in project settings to
                  see this cell's breakdown.
                </p>
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
                          doc={doc}
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
                          disabled={!editable || !onOpenRecording || isGitProject}
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
                          doc={doc}
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
                          disabled={!editable || !onOpenRecording || isGitProject}
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
                          disabled={!editable || !onOpenRecording || isGitProject}
                          className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                          title={
                            isGitProject
                              ? "Recording on GitLab projects isn't available yet"
                              : "Record audio"
                          }
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
