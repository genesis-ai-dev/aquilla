import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type RefObject, type UIEventHandler } from "react"
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
import type { TextValidationBlock } from "@/lib/review/text-validation-policy"
import { HealthRibbon } from "@/components/HealthRibbon"
import { TranslatedEditor, type TranslatedEditorCommit } from "../TranslatedEditor"
import { useT } from "@/lib/i18n/I18nProvider"

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
  /** AQU-1571: the project text rule refusing this viewer's vote here, if any
   *  (already folded into `canValidate`); it chooses the tooltip's words. */
  validationBlock?: TextValidationBlock | null
}

/**
 * What the workspace reports back about a committed workbench target edit.
 *
 * AQU-1497: the only bit the pane needs is whether the commit path validated
 * the edit by itself (`shouldAutoValidateHumanEdit`). That validation owes the
 * file's repeated segments its text exactly as a click on the validation
 * control does, and no click ever follows it — so the pane has to notice it to
 * pay the debt (see `settleOwedRepetitions` below).
 */
export interface AgentTargetCommitOutcome {
  autoValidated: boolean
}

export interface AgentContextPaneProps {
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
  onCommitTarget?: (
    cellId: string,
    snapshot: TranslatedEditorCommit,
  ) => AgentTargetCommitOutcome | void | Promise<AgentTargetCommitOutcome | void>
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
  /** AQU-1497: a settled human validation in this pane — the workspace fills
   *  the file's repeated source segments from it (AQU-1391). The explicit
   *  validation control reaches it through `onValidationChange`; a typed edit
   *  the commit path auto-validated reaches it from here, on leaving the cell. */
  onCellValidated?: (cellId: string) => unknown
  cellLockHolders?: ReadonlyMap<string, string>
  onClaimCell?: (cellId: string) => void
  onReleaseCell?: (cellId: string) => void
  onViewCell?: (cellId: string | null) => void
  onTargetPresenceSelection?: (cellId: string, selection: TargetPresenceSelection | null) => void
}

interface AgentContextRowsProps extends AgentContextPaneProps {
  paired?: boolean
  sourceLanguage?: string | null
}

function SourceContextCell({
  cell,
  language,
  paired,
  idmlStyleCatalog,
  idmlParagraphStyleId,
}: {
  cell: AgentWorkbenchCell
  language?: string | null
  paired: boolean
} & Pick<ComponentProps<typeof SanitizedRichHtml>, "idmlStyleCatalog" | "idmlParagraphStyleId">) {
  const t = useT()
  return (
    <EditorSourceCellSurface
      aria-label={`${cell.ref || "Cell"} — ${cell.status || "unvalidated"}`}
      dir="auto"
      lang={language || undefined}
      fontSize={13}
      reserveAction={false}
      className={cn("min-w-0", paired && "[&>[data-testid=source-context-line]]:h-7")}
      header={(
        <>
          {paired && <span className="@min-[36rem]:sr-only">{t("editor.column.source")}</span>}
          <span className="truncate font-mono text-[10px]">{cell.ref || "·"}</span>
        </>
      )}
    >
      <div className={cn("whitespace-pre-wrap break-words leading-relaxed", !cell.source && "italic text-muted-foreground")}>
        {cell.sourceHtml ? (
          <SanitizedRichHtml
            html={cell.sourceHtml}
            idmlStyleCatalog={idmlStyleCatalog}
            idmlParagraphStyleId={idmlParagraphStyleId}
          />
        ) : (
          <EditorPlainReadText text={cell.source} emptyLabel={t("agentWorkspace.noSourceText")} />
        )}
      </div>
    </EditorSourceCellSurface>
  )
}

/** Shared read/edit renderer. Paired rows leave scrolling to their document owner. */
export function AgentContextRows({
  kind,
  cells,
  language,
  focusedCellId,
  paired = false,
  sourceLanguage,
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
  onCellValidated,
  cellLockHolders,
  onClaimCell,
  onReleaseCell,
  onViewCell,
  onTargetPresenceSelection,
}: AgentContextRowsProps) {
  const t = useT()
  const isSource = kind === "source"
  const [editingCellId, setEditingCellId] = useState<string | null>(null)
  const [actionCellId, setActionCellId] = useState<string | null>(null)
  // AQU-200: which row (if any) has its rail `⋯` overflow open. Kept here, not
  // per-row, so at most one is open and so the open row's rail stays revealed
  // while the pointer is inside the popup rather than on the row.
  const [overflowCellId, setOverflowCellId] = useState<string | null>(null)
  const [writeError, setWriteError] = useState<{ cellId: string; message: string } | null>(null)
  const targetEditable = !isSource && editable && Boolean(onCommitTarget)

  // AQU-1497: a human validation in this pane owes the file's repeated source
  // segments its text ("Validating one fills the rest" — AQU-1391). The
  // explicit validation control pays that through `onValidationChange`, which
  // the workspace handles. A TYPED translation has no click to hang it on: the
  // commit path validates the edit itself, so the debt is recorded here and
  // paid when the edit is SETTLED — the editor no longer holds focus.
  //
  // Paying on an idle save with the caret still in the cell would re-broadcast
  // half-typed text to every repetition on each pause (the AQU-1484 rule,
  // mirrored from `settleOwedRepetitions` in EditorTable).
  const targetFocusedRef = useRef(false)
  const repetitionOwedCellRef = useRef<string | null>(null)
  // Latest-ref so settling never depends on the handler's identity: it runs
  // from blur/unmount paths where a changing dependency would be a hazard.
  const onCellValidatedRef = useRef(onCellValidated)
  useEffect(() => { onCellValidatedRef.current = onCellValidated }, [onCellValidated])
  const settleOwedRepetitions = useCallback(() => {
    const cellId = repetitionOwedCellRef.current
    if (!cellId || targetFocusedRef.current) return
    repetitionOwedCellRef.current = null
    void Promise.resolve(onCellValidatedRef.current?.(cellId)).catch((err) => {
      console.warn("[repetition-propagation] failed:", err)
    })
  }, [])
  /**
   * AQU-1497: the Target pane's validation control, wrapped so a validation it
   * records also fills the file's repeated source segments — the same trigger
   * the editor row owns for its gutter check (`emitValidationChange` in
   * EditorTable).
   *
   * Only on the way IN: un-validating withdraws a sign-off, it does not decide
   * any text is done, so it must push nothing anywhere. And only once the
   * workspace reports the change accepted (`false` = refused or failed), so a
   * validation that never landed propagates nothing.
   */
  const handleValidationChange = useCallback((cellId: string, validated: boolean) => {
    const change = Promise.resolve(onValidationChange?.(cellId, validated))
    void change.then(
      (accepted) => {
        if (!validated || accepted === false) return
        void Promise.resolve(onCellValidatedRef.current?.(cellId)).catch((err) => {
          console.warn("[repetition-propagation] failed:", err)
        })
      },
      // A failed validation is the control's to surface; nothing is owed.
      () => {},
    )
    return change
  }, [onValidationChange])
  const activeEditingCellId = editingCellId && cells.some((cell) => cell.cellId === editingCellId)
    ? editingCellId
    : null
  const editorHostRef = useRef<HTMLDivElement>(null)
  const claimedCellRef = useRef<string | null>(null)
  const releaseCellRef = useRef(onReleaseCell)
  useLayoutEffect(() => { releaseCellRef.current = onReleaseCell }, [onReleaseCell])
  const releaseClaim = useCallback(() => {
    const cellId = claimedCellRef.current
    if (!cellId) return
    claimedCellRef.current = null
    releaseCellRef.current?.(cellId)
  }, [])
  useLayoutEffect(() => releaseClaim, [activeEditingCellId, releaseClaim])
  useLayoutEffect(() => {
    if (paired && activeEditingCellId) {
      editorHostRef.current?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus({ preventScroll: true })
    }
  }, [activeEditingCellId, paired])
  // The editor can go away without ever firing a blur — the translator clicks
  // straight into another cell, the open file changes, the workbench collapses.
  // Each of those settles the edit too, so an owed propagation is never
  // stranded waiting for a blur that will not come.
  useEffect(() => {
    if (!activeEditingCellId) return
    return () => {
      targetFocusedRef.current = false
      settleOwedRepetitions()
    }
  }, [activeEditingCellId, settleOwedRepetitions])
  return (
    <>
          {cells.map((cell) => {
            const text = isSource ? cell.source : cell.target
            const heldByLabel = cellLockHolders?.get(cell.cellId) ?? null
            const editorLabel = `${cell.ref || "Cell"} — ${cell.status || "unvalidated"}`
            const canEditCell = targetEditable && !heldByLabel
            const targetHasRichFormatting = hasMeaningfulRichText(cell.targetHtml)
            const idmlStyleCatalog = cell.idmlConfiguration?.kind === "ready"
              ? cell.idmlConfiguration.context.styleCatalog
              : undefined
            const idmlParagraphStyleId = cell.idmlConfiguration?.kind === "ready"
              ? cell.idmlConfiguration.context.paragraphStyleId
              : undefined
            const completionState = completing?.get(cell.cellId)
            const isLoading = completionState === "searching" || completionState === "generating"
            const actionsRevealed = !isSource
              && (actionCellId === cell.cellId
                || activeEditingCellId === cell.cellId
                || overflowCellId === cell.cellId)
            const validation = onValidationChange && cell.validationStatus ? (
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
                blockedReason={cell.validationBlock ?? null}
                onValidationChange={(validated) => handleValidationChange(cell.cellId, validated)}
              />
            ) : null
            // AQU-200: same split as the editor's rail — AI generate stays a
            // direct button, comments/history collapse behind the `⋯`.
            const actions = (
              <CellActionRail
                revealed={actionsRevealed}
                expanded={false}
                onToggleExpanded={() => {}}
                showDetailsToggle={false}
                overflowOpen={overflowCellId === cell.cellId}
                onOverflowOpenChange={(open) => setOverflowCellId(open ? cell.cellId : null)}
                overflowAttentionDot={(openCommentCounts?.get(cell.cellId) ?? 0) > 0 ? "primary" : null}
                overflowLabel={t("editor.rail.moreActions")}
                primary={onDraftTarget && (
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
              >
                <TargetReferenceActions
                  cellId={cell.cellId}
                  openCommentCount={openCommentCounts?.get(cell.cellId)}
                  onOpenComments={onOpenComments}
                  onOpenHistory={onOpenHistory}
                />
              </CellActionRail>
            )
            return (
              <article
                key={cell.cellId}
                data-cell-id={cell.cellId}
                data-focused={cell.cellId === focusedCellId ? "true" : undefined}
                tabIndex={paired ? 0 : undefined}
                aria-label={paired ? cell.ref || t("common.cellLabel", { id: cell.cellId }) : undefined}
                className={cn(
                  "group min-w-0 border-l-2 border-l-transparent px-2 py-2",
                  paired && "grid grid-cols-1 items-stretch gap-2 outline-none @min-[36rem]:grid-cols-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  cell.cellId === focusedCellId && "border-l-primary bg-accent/35",
                )}
                onMouseEnter={() => { if (!isSource) setActionCellId(cell.cellId) }}
                onMouseLeave={(event) => {
                  if (!isSource && activeEditingCellId !== cell.cellId && !event.currentTarget.contains(document.activeElement)) {
                    setActionCellId(null)
                  }
                }}
                onFocusCapture={() => {
                  onViewCell?.(cell.cellId)
                  if (!isSource) setActionCellId(cell.cellId)
                }}
                onBlurCapture={(event) => {
                  if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
                  onViewCell?.(null)
                  if (isSource) return
                  if (activeEditingCellId !== cell.cellId) setActionCellId(null)
                }}
              >
                {(isSource || paired) && (
                  <SourceContextCell
                    cell={cell}
                    language={paired ? sourceLanguage : language}
                    paired={paired}
                    idmlStyleCatalog={idmlStyleCatalog}
                    idmlParagraphStyleId={idmlParagraphStyleId}
                  />
                )}
                {!isSource && (
                  <EditorTargetCellColumn
                    fontSize={13}
                    reserveActionRail={!paired}
                    className={cn(
                      "min-w-0",
                      paired && "px-2 py-1.5 [&>[data-testid=target-header-lane]]:h-auto [&>[data-testid=target-header-lane]]:min-h-7 [&>[data-testid=target-header-lane]]:flex-wrap",
                    )}
                    leading={cell.healthRibbonPoint ? (
                      <HealthRibbon
                        point={cell.healthRibbonPoint}
                        hasMajorIssue={cell.hasMajorHealthIssue}
                        hasIssue={cell.hasHealthIssue}
                      />
                    ) : undefined}
                    header={(
                      <>
                        {paired && <span className="@min-[36rem]:sr-only">{t("editor.column.target")}</span>}
                        {paired && validation}
                        <span className="truncate font-mono text-[10px]">{cell.ref || "·"}</span>
                        {cell.status && <span className="ml-auto text-[10px]">{cell.status}</span>}
                        {paired && <div className="ml-auto [&_button]:min-h-6 [&_button]:min-w-6">{actions}</div>}
                      </>
                    )}
                  >
                    {!paired && (
                      <div className="pointer-events-none absolute right-1 top-0.5 z-20">
                        <div className="pointer-events-auto">{actions}</div>
                      </div>
                    )}
                    <div ref={activeEditingCellId === cell.cellId ? editorHostRef : undefined} className="flex flex-1 gap-1.5">
                      {!paired && (validation ?? <div data-testid="validation-gutter" className="w-6 shrink-0" />)}
                    <EditorTargetCellWell empty={!text}>
                      {activeEditingCellId === cell.cellId ? (
                        <TranslatedEditor
                          cellId={cell.cellId}
                          initialPlain={cell.target}
                          initialHtml={cell.targetHtml}
                          idmlConfiguration={cell.idmlConfiguration}
                          onCommit={(snapshot) => {
                            setWriteError(null)
                            void Promise.resolve().then(() => onCommitTarget?.(cell.cellId, snapshot)).then((outcome) => {
                              // AQU-1497: the commit path validated this edit by
                              // itself, so the repetitions are owed its text —
                              // paid now if the translator has already left the
                              // cell, otherwise by the blur below.
                              if (!outcome?.autoValidated) return
                              repetitionOwedCellRef.current = cell.cellId
                              settleOwedRepetitions()
                            }).catch((error) => {
                              setWriteError({
                                cellId: cell.cellId,
                                message: error instanceof Error ? error.message : t("editor.write.saveFailed"),
                              })
                            })
                          }}
                          onFocus={() => {
                            targetFocusedRef.current = true
                            if (claimedCellRef.current === cell.cellId) return
                            releaseClaim()
                            claimedCellRef.current = cell.cellId
                            onClaimCell?.(cell.cellId)
                          }}
                          onBlur={() => {
                            targetFocusedRef.current = false
                            if (claimedCellRef.current === cell.cellId) releaseClaim()
                            settleOwedRepetitions()
                          }}
                          onSelectionChange={(selection) => onTargetPresenceSelection?.(cell.cellId, selection)}
                          onEscapeToGrid={() => {
                            targetFocusedRef.current = false
                            releaseClaim()
                            setEditingCellId(null)
                            if (paired) editorHostRef.current?.closest("article")?.focus({ preventScroll: true })
                            settleOwedRepetitions()
                          }}
                          placeholder={t("agentWorkspace.notTranslated")}
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
                          preserveWhitespace={Boolean(cell.idmlConfiguration)}
                          onClick={() => canEditCell && setEditingCellId(cell.cellId)}
                          onKeyDown={(event) => {
                            if (!canEditCell || event.key !== "Enter") return
                            event.preventDefault()
                            setEditingCellId(cell.cellId)
                          }}
                        >
                          {cell.idmlConfiguration && cell.targetHtml ? (
                            <TargetIdmlHtml
                              html={cell.targetHtml}
                              idmlStyleCatalog={idmlStyleCatalog}
                              idmlParagraphStyleId={idmlParagraphStyleId}
                            />
                          ) : targetHasRichFormatting && cell.targetHtml ? (
                            <TargetRichHtml html={cell.targetHtml} />
                          ) : (
                            <EditorPlainReadText text={text} emptyLabel={t("agentWorkspace.notTranslated")} />
                          )}
                        </EditorTargetReadSurface>
                      )}
                    </EditorTargetCellWell>
                    </div>
                    {heldByLabel && <p className="mt-1 text-[10px] text-muted-foreground">{t("agentWorkspace.editing", { name: heldByLabel })}</p>}
                    {writeError?.cellId === cell.cellId && <p role="alert" className="mt-1 text-[10px] text-destructive">{writeError.message}</p>}
                  </EditorTargetCellColumn>
                )}
                {isSource && heldByLabel && <p className="mt-1 text-[10px] text-muted-foreground">{t("agentWorkspace.editing", { name: heldByLabel })}</p>}
              </article>
            )
          })}
    </>
  )
}

export function AgentContextPane(props: AgentContextPaneProps) {
  const {
    kind, cells, language, fileName, totalCells, scopeAvailable = true,
    loading = false, onChooseFile, scrollContainerRef, onScroll,
  } = props
  const t = useT()
  const isSource = kind === "source"
  const title = t(isSource ? "editor.column.source" : "editor.column.target")
  const paneMeta = [language || null, t("common.cellCount", { count: totalCells ?? cells.length })]
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
        <span className="ml-auto max-w-40 truncate text-[10px] tabular-nums text-muted-foreground">{paneMeta}</span>
      </div>
      {cells.length > 0 ? (
        <div
          ref={scrollContainerRef}
          data-testid={`${kind}-context-scroll`}
          className="min-h-0 flex-1 divide-y divide-border/60 overflow-y-auto overscroll-contain"
          onScroll={onScroll}
        >
          <AgentContextRows {...props} />
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
                {t("agentWorkspace.chooseFile")}
              </Button>
            )}
          </EmptyContent>
        </Empty>
      )}
    </section>
  )
}
