/**
 * AQU-983: one modal for file-wide drafting and file-wide text validation.
 *
 * The counts are this file. The reader ticks what the run should touch.
 * Untouched AI drafts stay out of validation unless a reviewer or project
 * lead includes them; a contributor sees that box disabled and the reason.
 */
import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
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
  draftCells: readonly DraftChoiceCell[]
  onConfirmValidate: (choices: ValidateRunChoices) => void
  onConfirmDraft: (choices: DraftRunChoices) => void
}

export function BatchFileModal({
  open,
  onOpenChange,
  request,
  batchSize,
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
  const [includeEmpty, setIncludeEmpty] = useState(true)
  const [refreshAi, setRefreshAi] = useState(false)
  const [scope, setScope] = useState<"next" | "all">(request.kind === "draft" ? request.scope : "all")

  useEffect(() => {
    if (!open) return
    setIncludeReady(true)
    setIncludeAi(false)
    setIncludeEmpty(true)
    setRefreshAi(false)
    setScope(request.kind === "draft" ? request.scope : "all")
  }, [open, request])

  const validateGroups = useMemo(() => {
    const openSet = summarizeBatchValidate(validateCandidates, {
      ...validateOptions,
      cap: undefined,
      includeReadyCells: true,
      includeUntouchedAiDrafts: true,
    })
    return {
      ready: openSet.validatable.filter((cell) => !isUntouchedAiDraft(cell)),
      untouched: openSet.validatable.filter((cell) => isUntouchedAiDraft(cell)),
      blocked: openSet.outcome === "no-permission" || openSet.outcome === "no-target",
      blockedSummary: openSet,
    }
  }, [validateCandidates, validateOptions])

  const validatePreview = useMemo(() => summarizeBatchValidate(validateCandidates, {
    ...validateOptions,
    includeReadyCells: includeReady,
    includeUntouchedAiDrafts: canIncludeUntouchedAi && includeAi,
  }), [validateCandidates, validateOptions, includeReady, includeAi, canIncludeUntouchedAi])

  const draftGroups = useMemo(() => classifyBatchDraft(draftCells), [draftCells])
  const draftChoices = useMemo<DraftRunChoices>(() => ({
    includeEmpty,
    refreshAiDrafts: refreshAi,
    scope,
    batchSize,
  }), [includeEmpty, refreshAi, scope, batchSize])
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
    description = batchValidateConfirmDescription(
      validatePreview, t, list, validateOptions.cap,
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
