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
import { useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"
import {
  classifyBatchDraft,
  isUntouchedAiDraft,
  selectBatchDraft,
  type DraftChoiceCell,
  type DraftRunChoices,
  type ValidateRunChoices,
} from "@/lib/review/batch-file-options"
import {
  batchValidateConfirmDescription,
  noPermissionMessage,
  summarizeBatchValidate,
  type BatchValidateCandidate,
  type SummarizeOptions,
} from "@/lib/review/batch-validate-summary"
import { WHOLE_BOOK, applyChapterScope } from "@/lib/review/batch-scope"

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
  onConfirmValidate,
  onConfirmDraft,
}: BatchFileModalProps) {
  const t = useT()
  const { list } = useFormat()
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
    return {
      ready: openSet.validatable.filter((cell) => !isUntouchedAiDraft(cell)),
      untouched: openSet.validatable.filter((cell) => isUntouchedAiDraft(cell)),
      flagged: isFlagged ? openSet.validatable.filter((cell) => isFlagged(cell.id)) : [],
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

  const title = request.kind === "validate"
    ? t("editor.batchFile.validateTitle")
    : t("editor.batchFile.draftTitle")

  let description = ""
  let canConfirm = false
  if (request.kind === "validate" && validateGroups.blocked) {
    description = validateGroups.blockedSummary.outcome === "no-permission"
      ? noPermissionMessage(validateGroups.blockedSummary, t)
      : t("editor.batchValidate.noTarget")
  } else if (request.kind === "validate") {
    // AQU-2507: the fourth argument is the run's CHUNK size, not a ceiling —
    // the note it drives says the run finishes the file.
    description = batchValidateConfirmDescription(
      validatePreview, t, list, chunkSize,
      chapter === WHOLE_BOOK ? "file" : "chapter",
    )
    canConfirm = validatePreview.validatable.length > 0
  } else if (draftSelected.length === 0) {
    description = t("editor.batchFile.nothingToDraft")
  } else {
    description = t("editor.batchFile.draftWill", { count: draftSelected.length })
    canConfirm = true
  }

  const showDraftScope = request.kind === "draft" && draftIncludedCount > batchSize

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {(bookName || chapters.length > 0) && (
          <div className="flex flex-col gap-2">
            {bookName && (
              <p className="text-sm font-medium text-foreground">{bookName}</p>
            )}
            {chapters.length > 0 && (
              <Select
                value={chapter}
                onValueChange={(value) => { if (value) setChapter(value) }}
              >
                <SelectTrigger aria-label={t("editor.batchFile.chapterLabel")} className="w-full">
                  <SelectValue>
                    {chapter === WHOLE_BOOK ? t("editor.batchFile.wholeBook") : chapter}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {chapters.map((label) => (
                    <SelectItem key={label} value={label}>{label}</SelectItem>
                  ))}
                  <SelectItem value={WHOLE_BOOK}>{t("editor.batchFile.wholeBook")}</SelectItem>
                </SelectContent>
              </Select>
            )}
          </div>
        )}
        {request.kind === "validate" && !validateGroups.blocked && (
          <FieldSet>
            <FieldLegend variant="label">{t("editor.batchFile.legend")}</FieldLegend>
            {validateGroups.ready.length > 0 && (
              <OptionRow
                id="batch-file-ready"
                checked={includeReady}
                onCheckedChange={setIncludeReady}
                label={t("editor.batchFile.ready", { count: validateGroups.ready.length })}
                help={t("editor.batchFile.readyHelp")}
              />
            )}
            {validateGroups.untouched.length > 0 && (
              <OptionRow
                id="batch-file-ai"
                checked={canIncludeUntouchedAi && includeAi}
                disabled={!canIncludeUntouchedAi}
                onCheckedChange={setIncludeAi}
                label={t("editor.batchFile.aiDrafts", { count: validateGroups.untouched.length })}
                help={canIncludeUntouchedAi
                  ? t("editor.batchFile.aiDraftsHelp")
                  : t("editor.batchFile.aiDraftsLocked")}
              />
            )}
            {validateGroups.flagged.length > 0 && (
              <OptionRow
                id="batch-file-flagged"
                checked={includeFlagged}
                onCheckedChange={setIncludeFlagged}
                label={t("editor.batchFile.flagged", { count: validateGroups.flagged.length })}
                help={t("editor.batchFile.flaggedHelp")}
              />
            )}
          </FieldSet>
        )}
        {request.kind === "draft" && (
          <FieldSet>
            <FieldLegend variant="label">{t("editor.batchFile.legend")}</FieldLegend>
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
          {canConfirm && (
            <Button
              onClick={() => {
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

function OptionRow({
  id, checked, disabled, onCheckedChange, label, help,
}: {
  id: string
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
  label: string
  help: string
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
      </FieldContent>
    </Field>
  )
}
