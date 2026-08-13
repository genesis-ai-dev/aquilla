import { useState, type RefObject, type UIEventHandler } from "react"
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
import type { EditValidationSummary, ValidationStatus } from "@/hooks/useCells"
import type { HealthRibbonPoint } from "@/lib/health/health-ribbon"
import type { IdmlEditorConfiguration } from "@/lib/richtext/idml-editor"
import type { TargetPresenceSelection } from "@/lib/sync/presence-store"
import type { DirectionMode, TextDirection } from "@/lib/text-direction"
import { hasMeaningfulRichText } from "@/lib/richtext/editor-content"
import {
  EditorPlainReadText,
  SanitizedRichHtml,
  TargetIdmlHtml,
  TargetRichHtml,
} from "@/components/cell/EditorCellContent"
import {
  EditorSourceCellSurface,
  EditorTargetCellColumn,
  EditorTargetCellWell,
  EditorTargetReadSurface,
} from "@/components/cell/EditorCellSurface"
import { CellActionRail } from "@/components/CellActionRail"
import { TargetDraftActions, TargetReferenceActions } from "@/components/cell/TargetCellActions"
import { TargetValidationControl } from "@/components/cell/TargetValidationControl"
import { HealthRibbon } from "@/components/HealthRibbon"
import { TranslatedEditor, type TranslatedEditorCommit } from "../TranslatedEditor"

export interface AgentWorkbenchCell {
  cellId: string
  fileId: string
  ref?: string
  source: string
  sourceHtml?: string
  target: string
  targetHtml?: string
  status?: string
  idmlConfiguration?: IdmlEditorConfiguration | null
  targetTextDirection?: TextDirection
  targetDirectionMode?: DirectionMode
  healthRibbonPoint?: HealthRibbonPoint
  hasMajorHealthIssue?: boolean
  hasHealthIssue?: boolean
  validationStatus?: ValidationStatus
  activeValidators?: string[]
  validationHistory?: EditValidationSummary[]
  canValidate?: boolean
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
  isAnonymous?: boolean
  isCompletionConfigured?: boolean
  isCompletionAvailable?: boolean
  completing?: ReadonlyMap<string, string>
  onDraftTarget?: (cellId: string, options?: { regenerate?: boolean }) => void | boolean | Promise<boolean>
  onAiSetupNeeded?: () => void
  openCommentCounts?: ReadonlyMap<string, number>
  onOpenComments?: (cellId: string) => void
  onOpenHistory?: (cellId: string) => void
  currentUsername?: string
  validationRequirement?: number
  canValidate?: boolean
  onValidationChange?: (cellId: string, validated: boolean) => unknown
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
  isAnonymous = false,
  isCompletionConfigured = false,
  isCompletionAvailable = false,
  completing,
  onDraftTarget,
  onAiSetupNeeded,
  openCommentCounts,
  onOpenComments,
  onOpenHistory,
  currentUsername = "",
  validationRequirement = 1,
  canValidate = false,
  onValidationChange,
  cellLockHolders,
  onClaimCell,
  onReleaseCell,
  onTargetPresenceSelection,
}: AgentContextPaneProps) {
  const isSource = kind === "source"
  const title = isSource ? "Source" : "Target"
  const [editingCellId, setEditingCellId] = useState<string | null>(null)
  const [actionCellId, setActionCellId] = useState<string | null>(null)
  const [writeError, setWriteError] = useState<{ cellId: string; message: string } | null>(null)
  const targetEditable = !isSource && editable && Boolean(onCommitTarget)
  const activeEditingCellId = editingCellId && cells.some((cell) => cell.cellId === editingCellId)
    ? editingCellId
    : null
  const cellCount = totalCells ?? cells.length
  const paneMeta = [language || null, `${cellCount} cell${cellCount === 1 ? "" : "s"}`]
    .filter(Boolean)
    .join(" · ")

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
            const targetHasRichFormatting = hasMeaningfulRichText(cell.targetHtml)
            const completionState = completing?.get(cell.cellId)
            const isLoading = completionState === "searching" || completionState === "generating"
            const actionsRevealed = !isSource && (actionCellId === cell.cellId || activeEditingCellId === cell.cellId)
            return (
              <article
                key={cell.cellId}
                data-cell-id={cell.cellId}
                className={cn(
                  "group border-l-2 border-l-transparent px-2 py-2",
                  cell.cellId === focusedCellId && "border-l-primary bg-accent/35",
                )}
                onMouseEnter={() => { if (!isSource) setActionCellId(cell.cellId) }}
                onMouseLeave={() => { if (!isSource && activeEditingCellId !== cell.cellId) setActionCellId(null) }}
                onFocusCapture={() => { if (!isSource) setActionCellId(cell.cellId) }}
                onBlurCapture={(event) => {
                  if (isSource || event.currentTarget.contains(event.relatedTarget as Node | null)) return
                  if (activeEditingCellId !== cell.cellId) setActionCellId(null)
                }}
              >
                {isSource ? (
                  <EditorSourceCellSurface
                    aria-label={editorLabel}
                    dir="auto"
                    fontSize={13}
                    reserveAction={false}
                    header={<span className="truncate font-mono text-[10px]">{cell.ref || "·"}</span>}
                  >
                    <div className={cn("whitespace-pre-wrap break-words leading-relaxed", !text && "italic text-muted-foreground")}>
                      {cell.sourceHtml ? (
                        <SanitizedRichHtml html={cell.sourceHtml} />
                      ) : (
                        <EditorPlainReadText text={text} emptyLabel="No source text" />
                      )}
                    </div>
                  </EditorSourceCellSurface>
                ) : (
                  <EditorTargetCellColumn
                    fontSize={13}
                    reserveActionRail
                    leading={cell.healthRibbonPoint ? (
                      <HealthRibbon
                        point={cell.healthRibbonPoint}
                        hasMajorIssue={cell.hasMajorHealthIssue}
                        hasIssue={cell.hasHealthIssue}
                      />
                    ) : undefined}
                    header={(
                      <>
                        <span className="truncate font-mono text-[10px]">{cell.ref || "·"}</span>
                        {cell.status && <span className="ml-auto text-[10px]">{cell.status}</span>}
                      </>
                    )}
                  >
                    <div className="pointer-events-none absolute right-1 top-0.5 z-20">
                      <div className="pointer-events-auto">
                        <CellActionRail
                          revealed={actionsRevealed}
                          expanded={false}
                          onToggleExpanded={() => {}}
                          showDetailsToggle={false}
                        >
                          {onDraftTarget && (
                            <TargetDraftActions
                              targetText={cell.target}
                              status={cell.status}
                              editable={canEditCell}
                              isAnonymous={isAnonymous}
                              isCompletionConfigured={isCompletionConfigured}
                              isCompletionAvailable={isCompletionAvailable}
                              isLoading={isLoading}
                              onDraft={() => onDraftTarget(cell.cellId)}
                              onRegenerate={() => onDraftTarget(cell.cellId, { regenerate: true })}
                              onAiSetupNeeded={onAiSetupNeeded}
                            />
                          )}
                          <TargetReferenceActions
                            cellId={cell.cellId}
                            openCommentCount={openCommentCounts?.get(cell.cellId)}
                            onOpenComments={onOpenComments}
                            onOpenHistory={onOpenHistory}
                          />
                        </CellActionRail>
                      </div>
                    </div>
                    <div className="flex flex-1 gap-1.5">
                      {onValidationChange && cell.validationStatus ? (
                        <TargetValidationControl
                          cellRef={cell.ref || "Cell"}
                          hasContent={Boolean(text.trim())}
                          validationStatus={cell.validationStatus}
                          activeValidators={cell.activeValidators ?? []}
                          validationHistory={cell.validationHistory ?? []}
                          currentUsername={currentUsername}
                          validationRequirement={validationRequirement}
                          canValidate={canValidate}
                          canValidateThisCell={Boolean(cell.canValidate)}
                          onValidationChange={(validated) => onValidationChange(cell.cellId, validated)}
                        />
                      ) : (
                        <div data-testid="validation-gutter" className="w-6 shrink-0" />
                      )}
                    <EditorTargetCellWell empty={!text}>
                      {activeEditingCellId === cell.cellId ? (
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
                          className="min-h-12 w-full"
                        />
                      ) : (
                        <EditorTargetReadSurface
                          aria-readonly={!canEditCell}
                          aria-label={editorLabel}
                          dir={cell.targetTextDirection || "auto"}
                          lang={language || undefined}
                          tabIndex={canEditCell ? 0 : undefined}
                          editable={canEditCell}
                          empty={!text}
                          onClick={() => canEditCell && setEditingCellId(cell.cellId)}
                          onKeyDown={(event) => {
                            if (!canEditCell || event.key !== "Enter") return
                            event.preventDefault()
                            setEditingCellId(cell.cellId)
                          }}
                        >
                          {cell.idmlConfiguration && cell.targetHtml ? (
                            <TargetIdmlHtml html={cell.targetHtml} />
                          ) : targetHasRichFormatting && cell.targetHtml ? (
                            <TargetRichHtml html={cell.targetHtml} />
                          ) : (
                            <EditorPlainReadText text={text} emptyLabel="Not translated" />
                          )}
                        </EditorTargetReadSurface>
                      )}
                    </EditorTargetCellWell>
                    </div>
                  </EditorTargetCellColumn>
                )}
                {heldByLabel && <p className="mt-1 text-[10px] text-muted-foreground">{heldByLabel} is editing</p>}
                {writeError?.cellId === cell.cellId && <p role="alert" className="mt-1 text-[10px] text-destructive">{writeError.message}</p>}
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
