import { useRef, useCallback } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import * as Y from "yjs"
import DOMPurify from "dompurify"
import { Check } from "lucide-react"
import type { CellData } from "@/hooks/useCells"
import type { ScoredPair } from "@/lib/search/search-index"
import { appendCellHistory, validateCell } from "@/hooks/useCellHistory"
import { SparkleButton } from "./SparkleButton"
import { ExamplePanel } from "./ExamplePanel"
import { HighlightedText, buildHighlightsFromExamples } from "./HighlightedText"
import { HealthRing } from "./HealthRing"

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
}

export function EditorTable({
  cells, doc, username, isCompletionConfigured,
  completing, examples, errors,
  onCompleteSingle, onCompleteBatch, healthMap,
}: EditorTableProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)
  const dragCells = useRef<Set<string>>(new Set())

  const virtualizer = useVirtualizer({
    count: cells.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 90,
  })

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
                onCompleteSingle={onCompleteSingle}
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
}

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
  onCompleteSingle: (cell: CellData) => void
  onDragStart: () => void
  onDragEnter: () => void
}

function EditorRow({
  cell, doc, username, isCompletionConfigured, isLoading,
  cellExamples, highlights, error, health,
  onCompleteSingle, onDragStart, onDragEnter,
}: EditorRowProps) {
  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    appendCellHistory(doc, cell.id, {
      value: e.target.value,
      source: "human",
      author: username,
      validated: true,
    })
  }

  function handleValidate() {
    validateCell(doc, cell.id, username)
  }

  const healthValue = health ?? (cell.status === "validated" ? 100 : 0)

  const validationIcon = cell.translated && cell.translated.trim() ? (
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
        <span className="mb-1 block text-xs text-muted-foreground">{cell.context}</span>
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
          <textarea
            className="w-full resize-none rounded border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            value={cell.translated}
            onChange={handleChange}
            rows={Math.max(2, Math.ceil(cell.original.length / 50))}
          />
          {error && <p className="mt-0.5 text-xs text-destructive">{error}</p>}
        </div>
        <div className="flex flex-col items-center">
          {validationIcon}
        </div>
      </div>
    </div>
  )
}
