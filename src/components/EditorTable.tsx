import React, { useRef, useCallback, useMemo, useState, forwardRef, useImperativeHandle } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import * as Y from "yjs"
import DOMPurify from "dompurify"
import { Check, CheckCheck, Circle, Trash2, AlertTriangle, AlertCircle, RefreshCw, MessageCircle, Play } from "lucide-react"
import type { CellData } from "@/hooks/useCells"
import type { ScoredPair } from "@/lib/search/dual-index"
import type { TranslationRule, RuleInfraction, ProjectRecord, CellHealthBreakdown } from "@/lib/parsers/types"
import { useProjectPermissions } from "@/hooks/useProjectPermissions"
import { appendCellHistory, recordHistoryEntry, toggleCellValidation } from "@/hooks/useCellHistory"
import { commitCellEdit } from "@/lib/codex-editor/edits/commit-cell-edit"
import { getPlainText, getFragmentHtml } from "@/lib/richtext/translated-xml"
import { SparkleButton } from "./SparkleButton"
import { ExamplePanel } from "./ExamplePanel"
import { HighlightedText, buildHighlightsFromExamples } from "./HighlightedText"
import { HealthRing } from "./HealthRing"
import { HealthBreakdown } from "./HealthBreakdown/HealthBreakdown"
import { TranslatedEditor } from "./TranslatedEditor"
import { CellAudioButton } from "./CellAudioButton"
import { CellAudioRecordButton } from "./CellAudioRecordButton"
import { CellActionsMenu } from "./CellActionsMenu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { isPerfLogEnabled } from "@/lib/perf-log"

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
}

export const EditorTable = forwardRef<EditorTableHandle, EditorTableProps>(function EditorTable({
  project, cells, doc, username, isCompletionConfigured,
  completing, examples, errors,
  onCompleteSingle, onCompleteBatch, healthMap,
  infractions = new Map(), rules = [], onInfractionClick,
  isBacktranslationConfigured, onBacktranslate, backtranslating, backtranslationErrors,
  cellOpenCommentCount, onOpenComments, onOpenHistory,
  syncProvider, collabUser,
  activeCueIndex, onSeekToCue,
  lineNumbersEnabled, cellLabelsEnabled, sourceTextDirection, targetTextDirection,
  isAnonymous, breakdownMap, onJumpToCell, onAiSetupNeeded, onOpenRecording,
}, ref) {
  const permissions = useProjectPermissions(project)
  const canEdit = permissions.canEditContent
  const parentRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)
  const dragCells = useRef<Set<string>>(new Set())

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

  // Grid layout: [left-gutter] [source] [target] [right-gutter]. Each gutter
  // is 56px so a flex-wrap icon container fits two 24px buttons per row — short
  // cells collapse the icon stack into a 2-column grid instead of a tall tower.
  // Left gutter: audio + creation actions (AI, validation, play, mic, cue).
  // Right gutter: meta (infractions, backtranslation, comments, history).
  const gridCols = "grid-cols-[56px_1fr_1fr_56px]"

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

  return (
    <div ref={parentRef} className="h-full overflow-auto" onMouseUp={handleMouseUp}>
      <div className={cn("sticky top-0 z-10 grid gap-2 border-b bg-background px-4 py-2 text-sm font-medium text-muted-foreground", gridCols)}>
        <div />
        <div>Source</div>
        <div>Target</div>
        <div />
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
                onDragStart={handleDragStart}
                onDragEnter={handleDragEnter}
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
  gridCols: "grid-cols-[56px_1fr_1fr_56px]"
  isAnonymous?: boolean
  breakdownMap?: Map<string, CellHealthBreakdown>
  onJumpToCell?: (cellId: string) => void
  onAiSetupNeeded?: () => void
  onOpenRecording?: (cellId: string) => void
  onDragStart: (cellId: string) => void
  onDragEnter: (cellId: string) => void
}

const MemoizedRow = React.memo(function MemoizedRow(props: MemoizedRowProps) {
  const {
    cell, examples, completing, errors, healthMap, infractions,
    backtranslating, backtranslationErrors, cellOpenCommentCount, breakdownMap,
    activeCueIndex, rowIndex, gridCols,
    onDragStart: onDragStartParent, onDragEnter: onDragEnterParent,
    project, doc, username, editable, isCompletionConfigured,
    ruleMap, onCompleteSingle, onInfractionClick,
    isBacktranslationConfigured, onBacktranslate,
    onOpenComments, onOpenHistory, syncProvider, collabUser,
    onSeekToCue, lineNumbersEnabled, cellLabelsEnabled,
    sourceTextDirection, targetTextDirection, isAnonymous,
    onJumpToCell, onAiSetupNeeded, onOpenRecording,
  } = props

  const cellId = cell.id
  if (isPerfLogEnabled()) {
    const key = cellId.slice(0, 8)
    rowRenders.set(key, (rowRenders.get(key) ?? 0) + 1)
  }
  const cellExamples = useMemo(() => examples.get(cellId) ?? EMPTY_EXAMPLES, [examples, cellId])
  const highlights = useMemo(() => buildHighlightsFromExamples(cellExamples), [cellExamples])
  const cellInfractions = useMemo(() => infractions.get(cellId) ?? EMPTY_INFRACTIONS, [infractions, cellId])

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
        isLoading={isLoading}
        cellExamples={cellExamples}
        highlights={highlights}
        error={error}
        health={health}
        cellInfractions={cellInfractions}
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
        onDragStart={handleDragStart}
        onDragEnter={handleDragEnter}
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
  isLoading: boolean
  cellExamples: ScoredPair[]
  highlights: ReturnType<typeof buildHighlightsFromExamples>
  error?: string
  health: number | undefined
  cellInfractions: RuleInfraction[]
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
  rowIndex: number
  lineNumbersEnabled: boolean
  cellLabelsEnabled: boolean
  sourceTextDirection: "ltr" | "rtl"
  targetTextDirection: "ltr" | "rtl"
  gridCols: "grid-cols-[56px_1fr_1fr_56px]"
  isAnonymous?: boolean
  breakdown?: CellHealthBreakdown
  onJumpToCell?: (cellId: string) => void
  onAiSetupNeeded?: () => void
  onOpenRecording?: (cellId: string) => void
}

function EditorRow({
  project, cell, doc, username, editable, isCompletionConfigured, isLoading,
  cellExamples, highlights, error, health,
  cellInfractions, ruleMap,
  onCompleteSingle, onInfractionClick,
  isBacktranslationConfigured, isBacktranslating, backtranslationError, onBacktranslate,
  openCommentCount, onOpenComments, onOpenHistory,
  syncProvider, collabUser,
  isActiveCue: _isActiveCue, onSeekToCue,
  onDragStart, onDragEnter,
  rowIndex, lineNumbersEnabled, cellLabelsEnabled, sourceTextDirection, targetTextDirection, gridCols,
  isAnonymous, breakdown, onJumpToCell, onAiSetupNeeded, onOpenRecording,
}: EditorRowProps) {
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

  // Minimal CodexCell shape for CellAudioButton — only the metadata fields
  // the hook actually reads (selectedAudioId, attachments). Avoids plumbing
  // the entire CodexCell through CellData.
  const cellForButton = {
    kind: 2 as const,
    languageId: "html",
    value: cell.translated ?? "",
    metadata: {
      id: cell.id,
      type: (cell.type ?? "text") as "text",
      attachments: cell.attachments,
      selectedAudioId: cell.selectedAudioId,
    },
  } as unknown as import("@/lib/codex-editor/types").CodexCell

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

  const validationButton = hasContent ? (
    <div className="inline-flex items-center gap-0.5">
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
    </div>
  ) : null

  // SECURITY: originalHtml is sanitized through DOMPurify.sanitize() at the
  // render boundary. Parsers only produce safe inline tags (<b>, <i>, <u>,
  // <s>, <code>). DOMPurify provides defense-in-depth against XSS.
  const showLineNumber = lineNumbersEnabled && cell.type !== "paratext"
  const showCellLabel = cellLabelsEnabled && cell.cellLabel
  const hasGutterMetadata = showLineNumber || showCellLabel
  return (
    <div className={cn("group grid gap-2 border-b px-4 py-2 transition-colors", gridCols)}>
      {/* Left gutter — metadata on top, audio + creation actions below.
          flex-wrap with a max-height so if we add more icons later they flow
          into a 2nd column for short cells. */}
      <div className="flex flex-col items-center gap-1">
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
        {/*
          Flex-wrap icon container. Column direction with gap-1 means 4 icons
          take ~92px vertically; max-h-24 (96px) keeps them single-column for
          the common case, and anything beyond 4 wraps into a second column.
        */}
        <div
          className={cn(
            "flex flex-col flex-wrap content-start gap-1 max-h-24",
            hasGutterMetadata ? "pt-1" : "pt-5",
          )}
        >
          <SparkleButton
            disabled={!isCompletionConfigured || !editable || isAnonymous}
            loading={isLoading}
            onComplete={() => onCompleteSingle(cell)}
            onDragStart={onDragStart}
            onDragEnter={onDragEnter}
            onSetupNeeded={
              !isCompletionConfigured && editable && !isAnonymous
                ? onAiSetupNeeded
                : undefined
            }
            tooltip={
              isAnonymous
                ? "Sign in for AI translations"
                : !editable
                  ? "Read-only (imported from git)"
                  : isCompletionConfigured
                    ? "Generate translation"
                    : "Set up AI to enable"
            }
          />

          {validationButton}

          {/* Play-vs-mic are mutually exclusive. Play shows when a non-deleted
              audio attachment exists on the cell; otherwise the mic invites
              recording. Re-recording lives in the right-gutter ellipsis menu. */}
          {hasAudio ? (
            <CellAudioButton project={project} cell={cellForButton} />
          ) : (
            <CellAudioRecordButton
              project={project}
              onOpenRecording={() => onOpenRecording?.(cell.id)}
              disabled={!editable || !onOpenRecording}
            />
          )}

          {onSeekToCue && (
            <button
              type="button"
              onClick={() => onSeekToCue(cell.id)}
              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground/50 transition-[transform,color] duration-150 ease-out hover:bg-muted/60 hover:text-foreground active:scale-[0.92]"
              title="Play from this cue"
            >
              <Play className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* Source column */}
      <div dir={sourceTextDirection}>
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
            {highlights.length > 0 ? (
              <HighlightedText text={cell.original} highlights={highlights} />
            ) : (
              cell.original
            )}
          </div>
        )}
        {cellExamples.length > 0 && <ExamplePanel examples={cellExamples} />}
      </div>

      {/* Target column — actions live in the left gutter, so no right-side rail. */}
      <div dir={targetTextDirection}>
        <div>
          {cell.translatedXml ? (
            <TranslatedEditor
              fragment={cell.translatedXml}
              className="w-full"
              syncProvider={syncProvider}
              user={collabUser}
              onBlur={handleEditorBlur}
              editable={editable}
            />
          ) : (
            <textarea
              className="w-full resize-none rounded border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-70"
              value={cell.translated}
              onChange={handleChange}
              readOnly={!editable}
              rows={Math.max(2, Math.ceil(cell.original.length / 50))}
            />
          )}
          {error && <p className="mt-0.5 text-xs text-destructive">{error}</p>}
          {cell.backtranslation && (
            <div className="mt-1.5 rounded-md border-l-2 border-blue-400/70 bg-muted/30 px-2.5 py-1.5 text-xs italic text-muted-foreground">
              <div className="flex items-center gap-1.5 not-italic">
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">Backtranslation</span>
                {cell.backtranslationForText !== cell.translated && (
                  <span title="Translation has changed since backtranslation" className="flex items-center gap-0.5 rounded bg-amber-500/10 px-1 py-0.5 text-[9px] font-medium text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-2.5 w-2.5" />
                    stale
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onBacktranslate?.(cell)}
                  disabled={!isBacktranslationConfigured || isBacktranslating || !editable}
                  className="ml-auto flex h-4 w-4 items-center justify-center rounded text-muted-foreground/60 transition-[transform,color] duration-150 ease-out hover:bg-muted/60 hover:text-foreground active:scale-[0.92] disabled:cursor-not-allowed disabled:opacity-30"
                  title={!editable ? "Read-only (imported from git)" : "Regenerate"}
                >
                  <RefreshCw className={cn("h-3 w-3", isBacktranslating && "animate-spin")} />
                </button>
              </div>
              <div className="mt-1 leading-relaxed">{cell.backtranslation}</div>
            </div>
          )}
          {backtranslationError && (
            <p className="mt-0.5 text-xs text-destructive">BT: {backtranslationError}</p>
          )}
        </div>
      </div>

      {/* Right gutter — visible meta actions (comments + warnings) and an
          ellipsis menu for less-frequent ones (re-record, history, regenerate
          backtranslation). Keeping comments visible because they're the main
          collab surface; keeping infractions visible because they're warnings. */}
      <div className="flex flex-col flex-wrap content-start gap-1 max-h-24 pt-5">
        {onOpenComments && (
          <button
            type="button"
            className={cn(
              "relative flex h-5 w-5 items-center justify-center rounded transition-[transform,color] duration-150 ease-out active:scale-[0.92] hover:bg-muted/60",
              openCommentCount > 0 ? "text-primary" : "text-muted-foreground/50 hover:text-foreground",
            )}
            onClick={() => onOpenComments(cell.id)}
            title={openCommentCount > 0 ? `${openCommentCount} open comment${openCommentCount !== 1 ? "s" : ""}` : "Add comment"}
          >
            <MessageCircle className="h-3 w-3" />
            {openCommentCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-primary px-0.5 text-[8px] font-semibold leading-none text-primary-foreground tabular-nums">
                {openCommentCount}
              </span>
            )}
          </button>
        )}

        {cellInfractions.length > 0 && cellInfractions.map((inf) => {
          const rule = ruleMap.get(inf.ruleId)
          const isMajor = rule?.severity === "major"
          const Icon = isMajor ? AlertTriangle : AlertCircle
          return (
            <button
              key={inf.ruleId}
              type="button"
              onClick={() => onInfractionClick?.(inf.ruleId)}
              title={inf.message}
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded transition-[transform,color] duration-150 ease-out active:scale-[0.92] hover:bg-muted/60",
                isMajor ? "text-red-500 hover:text-red-600" : "text-amber-500 hover:text-amber-600"
              )}
            >
              <Icon className="h-3 w-3" />
            </button>
          )
        })}

        <CellActionsMenu
          cell={cell}
          editable={editable}
          hasAudio={hasAudio}
          isGitProject={project.origin?.kind === "git"}
          isBacktranslationConfigured={isBacktranslationConfigured}
          isBacktranslating={isBacktranslating}
          onOpenRecording={onOpenRecording}
          onOpenHistory={onOpenHistory}
          onBacktranslate={onBacktranslate}
        />
      </div>
    </div>
  )
}
