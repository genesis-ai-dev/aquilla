import { useEffect, useState, type RefObject, type UIEventHandler } from "react"
import { FileText, Languages } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { cn } from "@/lib/utils"
import type { IdmlEditorConfiguration } from "@/lib/richtext/idml-editor"
import type { TargetPresenceSelection } from "@/lib/sync/presence-store"
import type { DirectionMode, TextDirection } from "@/lib/text-direction"
import { TranslatedEditor, type TranslatedEditorCommit } from "../TranslatedEditor"

export interface AgentWorkbenchCell {
  cellId: string
  fileId: string
  ref?: string
  source: string
  target: string
  targetHtml?: string
  status?: string
  idmlConfiguration?: IdmlEditorConfiguration | null
  targetTextDirection?: TextDirection
  targetDirectionMode?: DirectionMode
}

interface AgentContextPaneProps {
  kind: "source" | "target"
  cells: AgentWorkbenchCell[]
  language?: string | null
  fileName?: string | null
  totalCells?: number
  focusedCellId?: string | null
  scopeAvailable?: boolean
  loading?: boolean
  onChooseFile?: () => void
  scrollContainerRef?: RefObject<HTMLDivElement | null>
  onScroll?: UIEventHandler<HTMLDivElement>
  editable?: boolean
  onCommitTarget?: (cellId: string, snapshot: TranslatedEditorCommit) => void | Promise<void>
  cellLockHolders?: ReadonlyMap<string, string>
  onClaimCell?: (cellId: string) => void
  onReleaseCell?: (cellId: string) => void
  onTargetPresenceSelection?: (cellId: string, selection: TargetPresenceSelection | null) => void
}

export function AgentContextPane({
  kind,
  cells,
  language,
  fileName,
  totalCells,
  focusedCellId,
  scopeAvailable = true,
  loading = false,
  onChooseFile,
  scrollContainerRef,
  onScroll,
  editable = false,
  onCommitTarget,
  cellLockHolders,
  onClaimCell,
  onReleaseCell,
  onTargetPresenceSelection,
}: AgentContextPaneProps) {
  const isSource = kind === "source"
  const title = isSource ? "Source" : "Target"
  const [editingCellId, setEditingCellId] = useState<string | null>(null)
  const [writeError, setWriteError] = useState<{ cellId: string; message: string } | null>(null)
  const targetEditable = !isSource && editable && Boolean(onCommitTarget)
  const cellCount = totalCells ?? cells.length
  const paneMeta = [
    language || null,
    `${cellCount} cell${cellCount === 1 ? "" : "s"}`,
  ].filter(Boolean).join(" · ")

  useEffect(() => {
    if (editingCellId && !cells.some((cell) => cell.cellId === editingCellId)) {
      setEditingCellId(null)
    }
  }, [cells, editingCellId])

  const emptyDescription = loading
    ? `Loading ${fileName ?? "file"}…`
    : !scopeAvailable
    ? "Choose a file to load its source and target text into the workbench."
    : fileName
      ? `No ${kind} text is available in ${fileName} yet.`
      : "Choose a file to give the agent a working area."

  return (
    <section aria-label={`${title} pane`} className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        <span className="text-[11px] font-semibold tracking-tight text-foreground/90">{title}</span>
        <span className="ml-auto max-w-40 truncate text-[10px] tabular-nums text-muted-foreground">
          {paneMeta}
        </span>
      </div>

      {cells.length > 0 ? (
        <div
          ref={scrollContainerRef}
          data-testid={`${kind}-context-scroll`}
          className="min-h-0 flex-1 divide-y divide-border/60 overflow-y-auto overscroll-contain"
          onScroll={onScroll}
        >
          {cells.map((cell) => {
            const text = isSource ? cell.source : cell.target
            const heldByLabel = cellLockHolders?.get(cell.cellId) ?? null
            const editorLabel = `${cell.ref || "Cell"} — ${cell.status || "unvalidated"}`
            const canEditCell = targetEditable && !heldByLabel
            return (
              <article
                key={cell.cellId}
                data-cell-id={cell.cellId}
                className={cn(
                  "border-l-2 border-l-transparent px-4 py-3",
                  cell.cellId === focusedCellId && "border-l-primary bg-accent/35",
                )}
              >
                <div className="mb-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span className="truncate font-mono">{cell.ref || "·"}</span>
                  {!isSource && cell.status && <span className="ml-auto">{cell.status}</span>}
                </div>
                {isSource ? (
                  <p dir="auto" className={cn("whitespace-pre-wrap break-words text-[13px] leading-6", !text && "italic text-muted-foreground")}>
                    {text || "No source text"}
                  </p>
                ) : editingCellId === cell.cellId ? (
                  <TranslatedEditor
                    cellId={cell.cellId}
                    initialPlain={cell.target}
                    initialHtml={cell.targetHtml}
                    idmlConfiguration={cell.idmlConfiguration}
                    onCommit={(snapshot) => {
                      setWriteError(null)
                      void Promise.resolve(onCommitTarget?.(cell.cellId, snapshot)).catch((error) => {
                        setWriteError({
                          cellId: cell.cellId,
                          message: error instanceof Error ? error.message : "Could not save this translation.",
                        })
                      })
                    }}
                    onFocus={() => onClaimCell?.(cell.cellId)}
                    onBlur={() => onReleaseCell?.(cell.cellId)}
                    onSelectionChange={(selection) => onTargetPresenceSelection?.(cell.cellId, selection)}
                    onEscapeToGrid={() => {
                      onReleaseCell?.(cell.cellId)
                      setEditingCellId(null)
                    }}
                    placeholder="Not translated"
                    editable={canEditCell}
                    heldByLabel={heldByLabel}
                    textDirection={cell.targetTextDirection}
                    directionMode={cell.targetDirectionMode}
                    lang={language || undefined}
                    ariaLabel={editorLabel}
                    className="min-h-12 w-full text-[13px] leading-6"
                  />
                ) : (
                  <div
                    role="textbox"
                    aria-multiline="true"
                    aria-readonly={!canEditCell}
                    aria-label={editorLabel}
                    dir={cell.targetTextDirection || "auto"}
                    lang={language || undefined}
                    tabIndex={canEditCell ? 0 : undefined}
                    className={cn(
                      "min-h-9 whitespace-pre-wrap break-words rounded-md px-1 py-0.5 text-[13px] leading-6 outline-none",
                      canEditCell && "cursor-text hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-primary/30",
                      !text && "italic text-muted-foreground",
                    )}
                    onClick={() => canEditCell && setEditingCellId(cell.cellId)}
                    onKeyDown={(event) => {
                      if (!canEditCell || event.key !== "Enter") return
                      event.preventDefault()
                      setEditingCellId(cell.cellId)
                    }}
                  >
                    {text || "Not translated"}
                  </div>
                )}
                {heldByLabel && <p className="mt-1 text-[10px] text-muted-foreground">{heldByLabel} is editing</p>}
                {writeError?.cellId === cell.cellId && (
                  <p role="alert" className="mt-1 text-[10px] text-destructive">{writeError.message}</p>
                )}
              </article>
            )
          })}
        </div>
      ) : (
        <Empty className="min-h-0 flex-1 px-5">
          <EmptyHeader>
            <EmptyMedia variant="icon">{isSource ? <FileText /> : <Languages />}</EmptyMedia>
            <EmptyTitle>{fileName ? `No ${kind} text` : "Choose a file"}</EmptyTitle>
            <EmptyDescription>{emptyDescription}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            {onChooseFile && !loading && (
              <Button type="button" variant="outline" size="sm" onClick={onChooseFile}>
                <FileText data-icon="inline-start" />
                Choose file
              </Button>
            )}
          </EmptyContent>
        </Empty>
      )}
    </section>
  )
}
