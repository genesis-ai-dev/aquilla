/**
 * AQU-983: one modal for file-wide drafting and file-wide text validation.
 *
 * The counts are this file. The reader ticks what the run should touch.
 * Untouched AI drafts stay out of validation unless a reviewer or project
 * lead includes them; a contributor sees that box disabled and the reason.
 *
 * AQU-2507: cells with an open check flag get the same treatment — counted,
 * named, left out by default, and taken only when the reader ticks the box.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { SearchSelect } from "@/components/ui/search-select"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  classifyBatchDraft,
  isUntouchedAiDraft,
  selectBatchDraft,
  type DraftChoiceCell,
  type DraftRunChoices,
  type ValidateRunChoices,
} from "@/lib/review/batch-file-options"
import {
  BATCH_VALIDATE_SKIP_REASONS,
  batchValidateChunkSize,
  batchValidateSkipClauses,
  noPermissionMessage,
  summarizeBatchValidate,
  type BatchValidateCandidate,
  type BatchValidateSummary,
  type SummarizeOptions,
} from "@/lib/review/batch-validate-summary"
import { WHOLE_BOOK, applyChapterScope } from "@/lib/review/batch-scope"
import { cn } from "@/lib/utils"

export type BatchFileModalRequest =
  | { kind: "validate" }
  | { kind: "draft"; scope: "next" | "all" }

interface BatchFileModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  request: BatchFileModalRequest
  batchSize: number
  canIncludeUntouchedAi: boolean
  validateCandidates: readonly BatchValidateCandidate[]
  validateOptions: SummarizeOptions
  /** AQU-2507: how many cells one batch of the run saves. Drives the note that
   *  tells the reader the single click finishes the file. */
  chunkSize: number
  /** The open book. Shown as a name: this dialog does not switch files. */
  bookName?: string
  /** Chapter labels in document order. Empty when the file has no chapters. */
  chapters?: readonly string[]
  /** The chapter the editor is on. `WHOLE_BOOK` when the file has none. */
  initialChapter?: string
  draftCells: readonly DraftChoiceCell[]
  /** Short check description for a flagged cell, when the project has one. */
  flagIssue?: (cellId: string) => string | undefined
  onConfirmValidate: (choices: ValidateRunChoices) => void
  onConfirmDraft: (choices: DraftRunChoices) => void
}

export function BatchFileModal({
  open,
  onOpenChange,
  request,
  batchSize,
  chunkSize,
  bookName,
  chapters = [],
  initialChapter = WHOLE_BOOK,
  canIncludeUntouchedAi,
  validateCandidates,
  validateOptions,
  draftCells,
  flagIssue,
  onConfirmValidate,
  onConfirmDraft,
}: BatchFileModalProps) {
  const t = useT()
  const [includeReady, setIncludeReady] = useState(true)
  const [includeAi, setIncludeAi] = useState(false)
  const [includeFlagged, setIncludeFlagged] = useState(false)
  const [includeEmpty, setIncludeEmpty] = useState(true)
  const [refreshAi, setRefreshAi] = useState(false)
  const [scope, setScope] = useState<"next" | "all">(request.kind === "draft" ? request.scope : "all")
  const [chapter, setChapter] = useState(initialChapter)
  // Reset once per opening. A later change to the chapter in view (the table
  // reports it as the reader scrolls) must not wipe a choice already made.
  const openedFor = useRef<BatchFileModalRequest | null>(null)

  useEffect(() => {
    if (!open) {
      openedFor.current = null
      return
    }
    if (openedFor.current === request) return
    openedFor.current = request
    setIncludeReady(true)
    setIncludeAi(false)
    setIncludeFlagged(false)
    setIncludeEmpty(true)
    setRefreshAi(false)
    setScope(request.kind === "draft" ? request.scope : "all")
    setChapter(chapters.includes(initialChapter) ? initialChapter : (chapters[0] ?? WHOLE_BOOK))
  }, [open, request, chapters, initialChapter])

  const scopedValidate = useMemo(
    () => applyChapterScope(validateCandidates, chapter),
    [validateCandidates, chapter],
  )
  const scopedDraft = useMemo(
    () => applyChapterScope(draftCells, chapter),
    [draftCells, chapter],
  )

  const validateGroups = useMemo(() => {
    // AQU-2507: `includeFlaggedCells: true` here so the GROUPS see every
    // eligible cell. The boxes below are built from this open set; counting
    // them with the default (flagged excluded) would hide the very cells the
    // flagged box exists to offer.
    const openSet = summarizeBatchValidate(scopedValidate, {
      ...validateOptions,
      cap: undefined,
      includeReadyCells: true,
      includeUntouchedAiDrafts: true,
      includeFlaggedCells: true,
    })
    const isFlagged = validateOptions.hasOpenFlags
    const flaggedCell = (cell: BatchValidateCandidate) => Boolean(isFlagged?.(cell.id))
    // A flagged line is its own box, named by its reference, including a
    // flagged AI draft. Counting that draft on the AI line made the title one
    // short and left the check off this list while the run still skipped it.
    return {
      ready: openSet.validatable.filter((cell) => !isUntouchedAiDraft(cell) && !flaggedCell(cell)),
      untouched: openSet.validatable.filter((cell) => isUntouchedAiDraft(cell) && !flaggedCell(cell)),
      flagged: isFlagged
        ? openSet.validatable.filter((cell) => flaggedCell(cell))
        : [],
      blocked: openSet.outcome === "no-permission" || openSet.outcome === "no-target",
      blockedSummary: openSet,
    }
  }, [scopedValidate, validateOptions])

  const validatePreview = useMemo(() => summarizeBatchValidate(scopedValidate, {
    ...validateOptions,
    includeReadyCells: includeReady,
    includeUntouchedAiDrafts: canIncludeUntouchedAi && includeAi,
    includeFlaggedCells: includeFlagged,
  }), [scopedValidate, validateOptions, includeReady, includeAi, canIncludeUntouchedAi, includeFlagged])

  const draftGroups = useMemo(() => classifyBatchDraft(scopedDraft), [scopedDraft])
  const draftChoices = useMemo<DraftRunChoices>(() => ({
    includeEmpty,
    refreshAiDrafts: refreshAi,
    scope,
    batchSize,
    chapter,
  }), [includeEmpty, refreshAi, scope, batchSize, chapter])
  const draftSelected = useMemo(
    () => selectBatchDraft(draftGroups, draftChoices),
    [draftGroups, draftChoices],
  )
  const draftIncludedCount = (includeEmpty ? draftGroups.empty.length : 0)
    + (refreshAi ? draftGroups.refreshable.length : 0)

  // The chapter (or the whole file) offered no box at all. The status below
  // says why.
  const nothingOffered = request.kind === "validate"
    && !validateGroups.blocked
    && validateGroups.ready.length === 0
    && validateGroups.untouched.length === 0
    && validateGroups.flagged.length === 0
  const emptyValidate = nothingOffered ? emptyValidateCopy(validatePreview, chapter, t) : null
  const validateCount = request.kind === "validate" && !validateGroups.blocked
    ? validatePreview.validatable.length
    : 0
  // The title names the cells this click will sign off. An empty selection
  // keeps the plain title: the boxes already say what was left out.
  const title = request.kind === "draft"
    ? t("editor.batchFile.draftTitle")
    : validateCount > 0
      ? t("editor.batchFile.validateCountTitle", { count: validateCount })
      : t("editor.batchFile.validateTitle")
  // AQU-2507: only when one click has to write more than one batch. The note
  // is the whole description; skipped cells stay on the checkboxes.
  const chunk = batchValidateChunkSize(chunkSize)
  const chunkNote = validateCount > chunk
    ? t(
      chapter === WHOLE_BOOK
        ? "nav.workspaceActions.batchValidate.runsToCompletion"
        : "nav.workspaceActions.batchValidate.runsToChapter",
      { cap: chunk },
    ).trim()
    : ""

  let description: string | null = null
  let canConfirm = false
  if (emptyValidate) {
    description = emptyValidate.announcement
  } else if (request.kind === "validate" && validateGroups.blocked) {
    description = validateGroups.blockedSummary.outcome === "no-permission"
      ? noPermissionMessage(validateGroups.blockedSummary, t)
      : t("editor.batchValidate.noTarget")
  } else if (request.kind === "validate") {
    description = chunkNote || null
    canConfirm = validateCount > 0
  } else if (draftSelected.length === 0) {
    description = t("editor.batchFile.nothingToDraft")
  } else {
    description = t("editor.batchFile.draftWill", { count: draftSelected.length })
    canConfirm = true
  }

  const showDraftScope = request.kind === "draft" && draftIncludedCount > batchSize
  // A whole Bible is a thousand chapters. SearchSelect mounts only the rows
  // in view; a plain Select mounted every one and the menu stalled on open.
  const chapterOptions = useMemo(
    () => [
      ...chapters.map((label) => ({ value: label, label })),
      { value: WHOLE_BOOK, label: t("editor.batchFile.wholeBook") },
    ],
    [chapters, t],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && (
            <DialogDescription className={emptyValidate ? "sr-only" : undefined}>
              {description}
            </DialogDescription>
          )}
        </DialogHeader>
        {(bookName || chapters.length > 0) && (
          <div className="flex flex-col gap-2">
            {bookName && (
              <p className="text-sm font-medium text-foreground">{bookName}</p>
            )}
            {chapters.length > 0 && (
              <SearchSelect
                aria-label={t("editor.batchFile.chapterLabel")}
                options={chapterOptions}
                value={chapter}
                onValueChange={setChapter}
              />
            )}
          </div>
        )}
        {emptyValidate && <EmptyValidateStatus copy={emptyValidate} />}
        {request.kind === "validate" && !validateGroups.blocked && (
          <FieldSet>
            {/* A chapter with none of a kind keeps the choice on screen, grayed.
                The tick stays, and the run still has no such cells to sign off. */}
            <OptionRow
              id="batch-file-ready"
              checked={includeReady}
              disabled={validateGroups.ready.length === 0}
              onCheckedChange={setIncludeReady}
              label={t("editor.batchFile.includeUnvalidated")}
              help={t("editor.batchFile.includeUnvalidatedHelp", { count: validateGroups.ready.length })}
            />
            <OptionRow
              id="batch-file-ai"
              checked={canIncludeUntouchedAi && includeAi}
              disabled={!canIncludeUntouchedAi || validateGroups.untouched.length === 0}
              onCheckedChange={setIncludeAi}
              label={t("editor.batchFile.aiDrafts", { count: validateGroups.untouched.length })}
              help={validateGroups.untouched.length === 0
                ? t("editor.batchBooks.aiDraftsHelp")
                : canIncludeUntouchedAi
                  ? t("editor.batchFile.aiDraftsHelp")
                  : t("editor.batchFile.aiDraftsLocked")}
            />
            <OptionRow
              id="batch-file-flagged"
              checked={includeFlagged}
              disabled={validateGroups.flagged.length === 0}
              onCheckedChange={setIncludeFlagged}
              label={t("editor.batchFile.includeUnresolved")}
              help={validateGroups.flagged.length > 0
                ? t("editor.batchFile.includeUnresolvedHelp")
                : t("editor.batchFile.flagged", { count: 0 })}
            >
              {validateGroups.flagged.length > 0 && (
                <FlaggedCells cells={validateGroups.flagged} flagIssue={flagIssue} />
              )}
            </OptionRow>
          </FieldSet>
        )}
        {request.kind === "draft" && (
          <FieldSet>
            {draftGroups.empty.length > 0 && (
              <OptionRow
                id="batch-file-empty"
                checked={includeEmpty}
                onCheckedChange={setIncludeEmpty}
                label={t("editor.batchFile.empty", { count: draftGroups.empty.length })}
                help={t("editor.batchFile.emptyHelp")}
              />
            )}
            {draftGroups.refreshable.length > 0 && (
              <OptionRow
                id="batch-file-refresh"
                checked={refreshAi}
                onCheckedChange={setRefreshAi}
                label={t("editor.batchFile.refresh", { count: draftGroups.refreshable.length })}
                help={t("editor.batchFile.refreshHelp")}
              />
            )}
            {draftGroups.humanOwned > 0 && (
              <p className="text-sm text-muted-foreground">
                {t("editor.batchFile.humanLeft", { count: draftGroups.humanOwned })}
              </p>
            )}
            {draftGroups.hidden > 0 && (
              <p className="text-sm text-muted-foreground">
                {t("editor.batchFile.hiddenLeft", { count: draftGroups.hidden })}
              </p>
            )}
            {showDraftScope && (
              <FieldSet>
                <FieldLegend variant="label">{t("editor.batchFile.scopeLegend")}</FieldLegend>
                <RadioGroup
                  value={scope}
                  onValueChange={(value) => setScope(value as "next" | "all")}
                >
                  <Field orientation="horizontal">
                    <RadioGroupItem value="next" id="batch-file-scope-next" />
                    <FieldLabel htmlFor="batch-file-scope-next">
                      {t("editor.batchFile.scopeNext", { count: Math.min(batchSize, draftIncludedCount) })}
                    </FieldLabel>
                  </Field>
                  <Field orientation="horizontal">
                    <RadioGroupItem value="all" id="batch-file-scope-all" />
                    <FieldLabel htmlFor="batch-file-scope-all">
                      {t("editor.batchFile.scopeAll", { count: draftIncludedCount })}
                    </FieldLabel>
                  </Field>
                </RadioGroup>
              </FieldSet>
            )}
          </FieldSet>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {canConfirm ? t("common.cancel") : t("common.close")}
          </Button>
          {(canConfirm || (request.kind === "validate" && emptyValidate)) && (
            <Button
              disabled={!canConfirm}
              onClick={() => {
                if (!canConfirm) return
                if (request.kind === "validate") {
                  onConfirmValidate({
                    includeReadyCells: includeReady,
                    includeUntouchedAiDrafts: canIncludeUntouchedAi && includeAi,
                    includeFlaggedCells: includeFlagged,
                    chapter,
                  })
                } else {
                  onConfirmDraft(draftChoices)
                }
              }}
            >
              {request.kind === "validate"
                ? t("editor.selection.validateText")
                : t("editor.batchFile.confirmDraft")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FlaggedCells({
  cells,
  flagIssue,
}: {
  cells: readonly BatchValidateCandidate[]
  flagIssue?: (cellId: string) => string | undefined
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-1.5">
      <CollapsibleTrigger className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        {t("editor.batchFile.unresolvedList", { count: cells.length })}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {/* Five cells: a verse line plus its check line, then the rest scrolls. */}
        <ul className="mt-1.5 max-h-[calc(5*2.75rem)] space-y-1.5 overflow-y-auto rounded-md border border-border px-2.5 py-1.5">
          {cells.map((cell) => {
            const note = flagIssue?.(cell.id)
            return (
              <li key={cell.id} className="text-sm">
                <span className="font-medium text-foreground">{cell.group?.trim() || cell.id}</span>
                {note ? <span className="block text-xs text-muted-foreground">{note}</span> : null}
              </li>
            )
          })}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

function emptyValidateCopy(
  summary: BatchValidateSummary,
  chapter: string,
  t: ReturnType<typeof useT>,
): { headline: string; lines: string[]; announcement: string } {
  const headline = chapter === WHOLE_BOOK
    ? t("editor.batchFile.nothingInFile")
    : t("editor.batchFile.nothingInChapterNamed", { chapter })
  const onlyAlreadyValidated = summary.skips.alreadyMine > 0
    && summary.skippedTotal === summary.skips.alreadyMine
  const lines = onlyAlreadyValidated
    ? [t("editor.batchFile.allAlreadyValidated", { count: summary.skips.alreadyMine })]
    : batchValidateSkipClauses(summary, t, BATCH_VALIDATE_SKIP_REASONS, false)
  const shown = lines.length > 0 ? lines : [t("editor.batchValidate.nothingEligibleNoReason")]
  return { headline, lines: shown, announcement: [headline, ...shown].join(". ") }
}

function EmptyValidateStatus({
  copy,
}: {
  copy: { headline: string; lines: string[] }
}) {
  return (
    <div role="status" className="text-sm font-medium text-foreground">
      <p>{copy.headline}</p>
      {copy.lines.length === 1 ? (
        <p className="mt-1">{copy.lines[0]}</p>
      ) : (
        <ul className="mt-1.5 list-disc space-y-0.5 ps-4">
          {copy.lines.map((line) => <li key={line}>{line}</li>)}
        </ul>
      )}
    </div>
  )
}

function OptionRow({
  id, checked, disabled, onCheckedChange, label, help, children,
}: {
  id: string
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
  label: string
  help: string
  children?: ReactNode
}) {
  return (
    <Field orientation="horizontal" data-disabled={disabled ? true : undefined}>
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription>{help}</FieldDescription>
        {children}
      </FieldContent>
    </Field>
  )
}
