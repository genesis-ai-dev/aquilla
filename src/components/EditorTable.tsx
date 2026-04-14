import { useRef, useCallback, useMemo, forwardRef, useImperativeHandle } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import * as Y from "yjs"
import DOMPurify from "dompurify"
import { Check, AlertTriangle, AlertCircle, Languages, RefreshCw, MessageCircle, History } from "lucide-react"
import type { CellData } from "@/hooks/useCells"
import type { ScoredPair } from "@/lib/search/search-index"
import type { TranslationRule, RuleInfraction } from "@/lib/parsers/types"
import { appendCellHistory, recordHistoryEntry, validateCell } from "@/hooks/useCellHistory"
import { getPlainText, getFragmentHtml } from "@/lib/richtext/translated-xml"
import { SparkleButton } from "./SparkleButton"
import { ExamplePanel } from "./ExamplePanel"
import { HighlightedText, buildHighlightsFromExamples } from "./HighlightedText"
import { HealthRing } from "./HealthRing"
import { TranslatedEditor } from "./TranslatedEditor"
import { cn } from "@/lib/utils"

export interface EditorTableHandle {
  scrollToCellIndex: (index: number) => void
}

interface EditorTableProps {
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
  syncProvider?: import("y-websocket").WebsocketProvider | null
  collabUser?: { name: string; color: string }
}

export const EditorTable = forwardRef<EditorTableHandle, EditorTableProps>(function EditorTable({
  cells, doc, username, isCompletionConfigured,
  completing, examples, errors,
  onCompleteSingle, onCompleteBatch, healthMap,
  infractions = new Map(), rules = [], onInfractionClick,
  isBacktranslationConfigured, onBacktranslate, backtranslating, backtranslationErrors,
  cellOpenCommentCount, onOpenComments, onOpenHistory,
  syncProvider, collabUser,
}, ref) {
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
  }), [virtualizer, cells.length])

  const handleMouseUp = useCallback(() => {
    if (isDragging.current && dragCells.current.size > 1) {
      const selected = cells.filter((c) => dragCells.current.has(c.id))
      onCompleteBatch(selected)
    }
    isDragging.current = false
    dragCells.current = new Set()
  }, [cells, onCompleteBatch])

  return (
    <div ref={parentRef} className="h-full overflow-auto" onMouseUp={handleMouseUp}>
      <div className="sticky top-0 z-10 grid grid-cols-[24px_1fr_1fr] gap-2 border-b bg-background px-4 py-2 text-sm font-medium text-muted-foreground">
        <div />
        <div>Source</div>
        <div>Target</div>
      </div>

      <div style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const cell = cells[virtualRow.index]
          const cellExamples = examples.get(cell.id) || []
          const completingState = completing.get(cell.id)
          const isLoading = completingState === "searching" || completingState === "generating"
          const highlights = buildHighlightsFromExamples(cellExamples)
          const cellInfractions = infractions.get(cell.id) || []
          const openCommentCount = cellOpenCommentCount?.get(cell.id) || 0
          const hasOpenComments = openCommentCount > 0

          return (
            <div
              key={cell.id}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
              }}
              className={cn(hasOpenComments && "border-l-2 border-l-blue-400")}
            >
              <EditorRow
                cell={cell}
                doc={doc}
                username={username}
                isCompletionConfigured={isCompletionConfigured}
                isLoading={isLoading}
                cellExamples={cellExamples}
                highlights={highlights}
                error={errors.get(cell.id)}
                health={healthMap.get(cell.id)}
                cellInfractions={cellInfractions}
                ruleMap={ruleMap}
                onCompleteSingle={onCompleteSingle}
                onInfractionClick={onInfractionClick}
                isBacktranslationConfigured={isBacktranslationConfigured}
                isBacktranslating={backtranslating?.has(cell.id)}
                backtranslationError={backtranslationErrors?.get(cell.id)}
                onBacktranslate={onBacktranslate}
                openCommentCount={openCommentCount}
                onOpenComments={onOpenComments}
                onOpenHistory={onOpenHistory}
                syncProvider={syncProvider}
                collabUser={collabUser}
                onDragStart={() => {
                  isDragging.current = true
                  dragCells.current = new Set([cell.id])
                }}
                onDragEnter={() => {
                  if (isDragging.current) dragCells.current.add(cell.id)
                }}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
})

interface EditorRowProps {
  cell: CellData
  doc: Y.Doc
  username: string
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
  syncProvider?: import("y-websocket").WebsocketProvider | null
  collabUser?: { name: string; color: string }
  onDragStart: () => void
  onDragEnter: () => void
}

function EditorRow({
  cell, doc, username, isCompletionConfigured, isLoading,
  cellExamples, highlights, error, health,
  cellInfractions, ruleMap,
  onCompleteSingle, onInfractionClick,
  isBacktranslationConfigured, isBacktranslating, backtranslationError, onBacktranslate,
  openCommentCount, onOpenComments, onOpenHistory,
  syncProvider, collabUser,
  onDragStart, onDragEnter,
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
        return
      }
    }

    recordHistoryEntry(doc, cell.id, {
      value: currentText,
      source: "human",
      author: username,
      validated: true,
    })
  }

  function handleValidate() {
    validateCell(doc, cell.id, username)
  }

  // Detect formatting loss: source has inline style marks that the target doesn't.
  const sourceHasFormatting = Boolean(cell.originalHtml && /<(b|strong|i|em|u|s|strike|del|code)\b/i.test(cell.originalHtml))
  const targetHtml = cell.translatedXml ? getFragmentHtml(cell.translatedXml) : ""
  const targetHasFormatting = /<(b|strong|i|em|u|s|strike|del|code)\b/i.test(targetHtml)
  const showFormattingLossWarning =
    sourceHasFormatting && !targetHasFormatting && cell.translated.trim().length > 0

  const healthValue = health ?? (cell.status === "validated" ? 100 : 0)

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

  const validationIcon = cell.translated && cell.translated.trim() ? (
    <div className="flex flex-col items-center" title={healthTooltip}>
      <HealthRing health={healthValue} size={22} strokeWidth={2.5}>
        {cell.status === "validated" ? (
          <Check className="h-3 w-3 text-green-500" />
        ) : cell.status === "unvalidated" ? (
          <button
            className="flex h-full w-full items-center justify-center rounded-full text-amber-500 hover:text-green-500"
            title="Click to validate"
            onClick={handleValidate}
          >
            <Check className="h-3 w-3" />
          </button>
        ) : null}
      </HealthRing>
      <span className="mt-0.5 text-[9px] tabular-nums text-muted-foreground">{healthValue}%</span>
      {cellInfractions.length > 0 && (
        <div className="mt-0.5 flex gap-0.5">
          {cellInfractions.map((inf) => {
            const rule = ruleMap.get(inf.ruleId)
            const isMajor = rule?.severity === "major"
            const Icon = isMajor ? AlertTriangle : AlertCircle
            return (
              <button key={inf.ruleId} onClick={() => onInfractionClick?.(inf.ruleId)}
                title={inf.message}
                className={isMajor ? "text-red-500 hover:text-red-700" : "text-amber-500 hover:text-amber-700"}>
                <Icon className="h-3 w-3" />
              </button>
            )
          })}
        </div>
      )}
      {isBacktranslationConfigured !== undefined && (
        <button
          className={cn(
            "mt-1 flex h-5 w-5 items-center justify-center rounded",
            isBacktranslating ? "animate-pulse text-primary" : "text-muted-foreground hover:text-primary",
            !isBacktranslationConfigured && "cursor-not-allowed text-muted-foreground/30"
          )}
          disabled={!isBacktranslationConfigured || isBacktranslating}
          onClick={() => onBacktranslate?.(cell)}
          title={
            !isBacktranslationConfigured
              ? "Configure LLM in settings"
              : isBacktranslating
                ? "Generating..."
                : cell.backtranslation ? "Regenerate backtranslation" : "Generate backtranslation"
          }
        >
          <Languages className="h-3 w-3" />
        </button>
      )}
    </div>
  ) : null

  // SECURITY: originalHtml is sanitized through DOMPurify.sanitize() at the
  // render boundary. Parsers only produce safe inline tags (<b>, <i>, <u>,
  // <s>, <code>). DOMPurify provides defense-in-depth against XSS.
  return (
    <div className="grid grid-cols-[24px_1fr_1fr] gap-2 border-b px-4 py-2">
      {/* Sparkle column */}
      <div className="flex flex-col items-center pt-5">
        <SparkleButton
          disabled={!isCompletionConfigured}
          loading={isLoading}
          onComplete={() => onCompleteSingle(cell)}
          onDragStart={onDragStart}
          onDragEnter={onDragEnter}
          tooltip={isCompletionConfigured ? "Generate translation" : "Configure LLM in settings"}
        />
      </div>

      {/* Source column */}
      <div>
        <div className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
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

      {/* Target column */}
      <div className="flex gap-1">
        <div className="flex-1">
          {cell.translatedXml ? (
            <TranslatedEditor
              fragment={cell.translatedXml}
              className="w-full"
              syncProvider={syncProvider}
              user={collabUser}
              onBlur={handleEditorBlur}
            />
          ) : (
            <textarea
              className="w-full resize-none rounded border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              value={cell.translated}
              onChange={handleChange}
              rows={Math.max(2, Math.ceil(cell.original.length / 50))}
            />
          )}
          {error && <p className="mt-0.5 text-xs text-destructive">{error}</p>}
          {cell.backtranslation && (
            <div className="mt-1 rounded border-l-2 border-blue-400 bg-muted/30 px-2 py-1 text-xs italic text-muted-foreground">
              <div className="flex items-center gap-1.5 not-italic">
                {cell.backtranslationForText !== cell.translated && (
                  <span title="Translation has changed since backtranslation" className="flex items-center gap-0.5 text-amber-500">
                    <AlertTriangle className="h-3 w-3" />
                    stale
                  </span>
                )}
                <button
                  onClick={() => onBacktranslate?.(cell)}
                  disabled={!isBacktranslationConfigured || isBacktranslating}
                  className="text-muted-foreground hover:text-primary disabled:opacity-30"
                  title="Regenerate"
                >
                  <RefreshCw className={cn("h-3 w-3", isBacktranslating && "animate-spin")} />
                </button>
                <span className="text-[10px] font-medium">backtranslation</span>
              </div>
              <div className="mt-0.5">{cell.backtranslation}</div>
            </div>
          )}
          {backtranslationError && (
            <p className="mt-0.5 text-xs text-destructive">BT: {backtranslationError}</p>
          )}
        </div>
        <div className="flex flex-col items-center">
          {validationIcon}
          {onOpenComments && (
            <button
              className={cn(
                "mt-1 flex h-5 w-5 items-center justify-center rounded relative",
                openCommentCount > 0 ? "text-primary" : "text-muted-foreground/50 hover:text-muted-foreground"
              )}
              onClick={() => onOpenComments(cell.id)}
              title={openCommentCount > 0 ? `${openCommentCount} open comment${openCommentCount !== 1 ? "s" : ""}` : "Add comment"}
            >
              <MessageCircle className="h-3 w-3" />
              {openCommentCount > 0 && (
                <span className="absolute -top-1 -right-1 flex h-3 w-3 items-center justify-center rounded-full bg-primary text-[8px] font-bold text-primary-foreground">
                  {openCommentCount}
                </span>
              )}
            </button>
          )}
          {onOpenHistory && (cell.history.length > 0 || (cell.translated && cell.translated.trim())) && (
            <button
              className={cn(
                "mt-1 flex h-5 w-5 items-center justify-center rounded hover:text-primary",
                cell.history.length > 0 ? "text-muted-foreground/80" : "text-muted-foreground/40"
              )}
              onClick={() => onOpenHistory(cell.id)}
              title={
                cell.history.length > 0
                  ? `Edit history (${cell.history.length} revision${cell.history.length !== 1 ? "s" : ""})`
                  : "Edit history (empty)"
              }
            >
              <History className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
