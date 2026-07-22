// Floating action bar that appears whenever the user has multi-selected
// cells. Surfaces bulk Translate / Validate / Generate Audio / Both.
//
// Synth uses the project's default voice; per-voice generation and the voice
// library live in the Voice Studio.

// Phase 2c-gamma: bulk synth + Y.Doc-driven validate are gone. The
// selection bar still surfaces the count + Translate (via completeBatch,
// which now drives the LLM stream without writing the result back) so the
// multi-select UX stays useful. Validate and Speak/Translate+Speak are
// disabled until the audio-attachment + validate-via-events grammars land.

import { useCallback, useEffect, useMemo, useState } from "react"
import { Languages, Sparkles, Wand2, X } from "lucide-react"
import { toast } from "sonner"
import { Spinner } from "@/components/ui/spinner"
import type { CellData } from "@/hooks/useCells"
import { type CellStore, readAtVersion, useCellStoreVersion } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { clearSelection, useSelectedIds } from "@/lib/audio/selection"
import { emitCellValidate, emitCellUnvalidate } from "@/lib/sync/events-emit"
import { canPerform } from "@/lib/sync/role-policy"
import { isBulkValidationEligible } from "@/lib/review/review-eligibility"

interface Props {
  project: ProjectRecord
  cellStore: CellStore
  session: FrontierSession | null
  username: string
  completeSingle?: (cell: CellData) => Promise<void> | void
  completeBatch?: (cells: CellData[]) => Promise<void> | void
  /** Audio mode surfaces "Voice together" instead of Translate/Validate. */
  audioMode?: boolean
  /** Synthesize the selected cells as one continuous clip + slice per cell. */
  onVoiceTogether?: (cells: CellData[]) => Promise<void> | void
  /**
   * AQU-186: called when the user clicks "Harmonize…" on the selection bar.
   * Receives the subset of selected cells that have at least one active
   * fix-review proposal. The parent opens FixReviewPanel in multi-cell scope.
   * Optional — when absent the button is not rendered.
   */
  onHarmonize?: (cells: CellData[]) => void
  /**
   * AQU-186: whether the current user has the harmonize_min_role.
   * When false, the button is disabled (server is still authoritative).
   */
  canHarmonize?: boolean
  /**
   * AQU-616: called right after a bulk validate/unvalidate enqueues its events,
   * so the parent can flush the outbox immediately + revalidate. Without this,
   * bulk validations sit in the outbox until the periodic ~5s flusher drains
   * them, so the "Queued → Synced" confirm lags for seconds even though the
   * icon updates optimistically. Every other validate path already flushes on
   * commit; this closes that gap.
   */
  onValidationCommitted?: () => void
}

type Running =
  | { kind: "idle" }
  | { kind: "translate" }
  | { kind: "validate" }
  | { kind: "voice" }

export function SelectionBar({ project, cellStore, username, completeBatch, audioMode, onVoiceTogether, onHarmonize, canHarmonize = true, onValidationCommitted }: Props) {
  const selected = useSelectedIds()
  const cellStoreVersion = useCellStoreVersion(cellStore)
  const [running, setRunning] = useState<Running>({ kind: "idle" })

  useEffect(() => {
    if (selected.size === 0) return
    const onKey = (e: KeyboardEvent) => {
      // Don't steal Esc when the user is typing/editing — those handlers run
      // first and clear focus naturally. Only act when no editable element
      // is focused.
      if (e.key !== "Escape") return
      const ae = document.activeElement
      const editing = ae instanceof HTMLElement &&
        (ae.isContentEditable || ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")
      if (editing) return
      clearSelection()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [selected.size])

  const selectedCells = useMemo(() => {
    return readAtVersion(cellStoreVersion, () => cellStore.getCellsByIds(selected))
  }, [cellStore, cellStoreVersion, selected])

  const missingCount = useMemo(
    () => selectedCells.filter((c) => !c.translated.trim() && c.original?.trim()).length,
    [selectedCells],
  )
  const validatableCount = useMemo(
    () => selectedCells.filter(
      (c) => isBulkValidationEligible(c) && !c.activeValidators.includes(username),
    ).length,
    [selectedCells, username],
  )
  const unvalidatableCount = useMemo(
    () => selectedCells.filter(
      (c) => c.translated.trim() && c.activeValidators.includes(username),
    ).length,
    [selectedCells, username],
  )
  // When nothing is validatable, explain the actual reason rather than always
  // blaming AI drafts. Priority: everything already validated by me → AI
  // drafts needing individual review → cells still lacking a translation.
  const validateDisabledReason = useMemo(() => {
    if (validatableCount > 0) return null
    const alreadyMine = selectedCells.filter(
      (c) => isBulkValidationEligible(c) && c.activeValidators.includes(username),
    ).length
    const aiDrafts = selectedCells.filter(
      (c) => c.translated.trim() && c.targetEventId && c.aiDrafted,
    ).length
    const needTranslation = selectedCells.filter((c) => !c.translated.trim()).length
    if (alreadyMine > 0 && aiDrafts === 0 && needTranslation === 0) {
      return "All selected cells are already validated by you"
    }
    if (aiDrafts > 0) return "Nothing eligible — untouched AI drafts require individual review"
    if (needTranslation > 0) return "Selected cells need a translation first"
    return "Nothing eligible to validate"
  }, [validatableCount, selectedCells, username])
  const allHaveTranslation = selectedCells.length > 0 && selectedCells.every((c) => c.translated.trim())
  const voiceableCount = useMemo(
    () => selectedCells.filter((c) => c.type !== "paratext" && c.translated.trim()).length,
    [selectedCells],
  )
  // AQU-186: cells with at least one infraction or fix proposal — v1 minimum:
  // show affordance when ≥ 1 selected cell has a translated value (proxy for
  // "may have violations"; real infraction data wires in when worker lands).
  const harmonizableCount = useMemo(
    () => selectedCells.filter((c) => c.translated.trim()).length,
    [selectedCells],
  )
  const isBusy = running.kind !== "idle"

  const onTranslate = useCallback(async () => {
    if (isBusy) return
    setRunning({ kind: "translate" })
    try {
      const missing = selectedCells.filter(
        (c) => !c.translated.trim() && c.original?.trim(),
      )
      if (missing.length > 0 && completeBatch) {
        await completeBatch(missing)
      }
    } finally {
      setRunning({ kind: "idle" })
    }
  }, [selectedCells, completeBatch, isBusy])

  const onVoice = useCallback(async () => {
    if (isBusy || !onVoiceTogether) return
    setRunning({ kind: "voice" })
    try {
      await onVoiceTogether(selectedCells.filter((c) => c.type !== "paratext" && c.translated.trim()))
    } finally {
      setRunning({ kind: "idle" })
    }
  }, [selectedCells, onVoiceTogether, isBusy])

  const onValidate = useCallback(() => {
    if (isBusy) return
    if (validatableCount === 0) return
    setRunning({ kind: "validate" })
    try {
      let validated = 0
      let alreadyValidated = 0
      for (const cell of selectedCells) {
        if (!isBulkValidationEligible(cell)) continue
        if (cell.activeValidators.includes(username)) { alreadyValidated++; continue }
        if (!cell.targetEventId || !project.id) continue
        void emitCellValidate({
          projectId: project.id,
          fileId: cell.fileId,
          cellId: cell.id,
          author: username,
          editEventId: cell.targetEventId,
        })
        validated++
      }
      const msg = alreadyValidated > 0
        ? `Validated ${validated} cell${validated === 1 ? "" : "s"} (${alreadyValidated} already validated)`
        : `Validated ${validated} cell${validated === 1 ? "" : "s"}`
      toast.success(msg)
      // AQU-616: flush the just-enqueued validates now instead of waiting for
      // the ~5s periodic flusher, so the confirmed/synced state lands promptly.
      if (validated > 0) onValidationCommitted?.()
    } finally {
      setRunning({ kind: "idle" })
    }
  }, [selectedCells, username, validatableCount, isBusy, project.id, onValidationCommitted])

  const onUnvalidate = useCallback(() => {
    if (isBusy) return
    if (unvalidatableCount === 0) return
    setRunning({ kind: "validate" })
    try {
      let removed = 0
      for (const cell of selectedCells) {
        if (!cell.translated.trim()) continue
        if (!cell.activeValidators.includes(username)) continue
        if (!cell.targetEventId || !project.id) continue
        void emitCellUnvalidate({
          projectId: project.id,
          fileId: cell.fileId,
          cellId: cell.id,
          author: username,
          editEventId: cell.targetEventId,
        })
        removed++
      }
      toast.success(`Removed validations from ${removed} cell${removed === 1 ? "" : "s"}`)
      // AQU-616: flush now rather than waiting for the periodic flusher.
      if (removed > 0) onValidationCommitted?.()
    } finally {
      setRunning({ kind: "idle" })
    }
  }, [selectedCells, username, unvalidatableCount, isBusy, project.id, onValidationCommitted])

  // AQU-365: viewers (and any role below the lowest gated action here —
  // REVIEWER 300, the validate floor) get no selection affordance at all.
  // canPerform fails OPEN when the role is unknown (local/legacy projects
  // with no syncRole), so this only suppresses the bar for a KNOWN
  // sub-reviewer role — never blocks legacy non-cloud projects.
  const roleLevel = project.syncRole?.level ?? null
  if (roleLevel != null && !canPerform("cell.validate", roleLevel) && !canPerform("target.cell.commit", roleLevel)) {
    return null
  }

  if (selectedCells.length === 0) return null

  return (
    <div
      className={cn(
        "pointer-events-auto fixed left-1/2 z-30 flex -translate-x-1/2 items-center gap-2",
        "bottom-4 rounded-md border bg-card px-4 py-2 text-xs ring-1 ring-foreground/10",
      )}
      role="toolbar"
      aria-label="Selection actions"
    >
      <span className="font-medium">
        {selectedCells.length} selected
        {missingCount > 0 && (
          <span className="ml-1 text-muted-foreground">
            ({missingCount} need translation)
          </span>
        )}
      </span>
      <div className="mx-1 h-5 w-px rounded-full" />
      {audioMode && (
        <AppTooltip content={
          !onVoiceTogether ? "Voicing isn't available here" :
          voiceableCount < 2 ? "Select at least two translated lines" :
          `Voice ${voiceableCount} lines as one clip`
        }>
          <Button
            type="button"
            size="sm"
            variant="default"
            onClick={onVoice}
            disabled={isBusy || voiceableCount < 2 || !onVoiceTogether}
          >
            {running.kind === "voice" ? (
              <Spinner className="mr-1 size-3.5" />
            ) : (
              <Sparkles className="mr-1 h-3.5 w-3.5" />
            )}
            Voice together
            {voiceableCount > 1 && (
              <span className="ml-1 rounded-md bg-primary-foreground/20 px-1.5 py-0.5 tabular-nums text-primary-foreground">
                {Math.min(voiceableCount, 12)}
              </span>
            )}
          </Button>
        </AppTooltip>
      )}
      {!audioMode && (
        <>
      <AppTooltip content={
        !completeBatch ? "Translation isn't configured for this project" :
        missingCount === 0 ? "All selected cells already have translations" :
        `Translate ${missingCount} missing`
      }>
        <Button
          type="button"
          size="sm"
          variant="default"
          onClick={onTranslate}
          disabled={isBusy || missingCount === 0 || !completeBatch}
        >
          {running.kind === "translate" ? (
            <Spinner className="mr-1 size-3.5" />
          ) : (
            <Languages className="mr-1 h-3.5 w-3.5" />
          )}
          Translate
          {missingCount > 0 && allHaveTranslation === false && (
            <span className="ml-1 rounded-md bg-primary-foreground/20 px-1.5 py-0.5 tabular-nums text-primary-foreground">
              {missingCount}
            </span>
          )}
        </Button>
      </AppTooltip>
      <AppTooltip content={
        validateDisabledReason
          ? validateDisabledReason
          : `Validate ${validatableCount} cell${validatableCount === 1 ? "" : "s"}`
      }>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onValidate}
          disabled={isBusy || validatableCount === 0}
        >
          {running.kind === "validate" ? (
            <Spinner className="mr-1 size-3.5" />
          ) : null}
          Validate
          {validatableCount > 0 && (
            <span className="ml-1 rounded-md bg-muted px-1.5 py-0.5 tabular-nums text-muted-foreground">
              {validatableCount}
            </span>
          )}
        </Button>
      </AppTooltip>
      <AppTooltip content={
        unvalidatableCount === 0
          ? "No cells have your validation"
          : `Remove your validation from ${unvalidatableCount} cell${unvalidatableCount === 1 ? "" : "s"}`
      }>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onUnvalidate}
          disabled={isBusy || unvalidatableCount === 0}
        >
          Remove my validations
          {unvalidatableCount > 0 && (
            <span className="ml-1 rounded-md bg-muted px-1.5 py-0.5 tabular-nums text-muted-foreground">
              {unvalidatableCount}
            </span>
          )}
        </Button>
      </AppTooltip>
      {/* AQU-186: Harmonize affordance — appears when ≥ 1 selected cell has a
          translation (v1 minimum per spec). Disabled when canHarmonize=false
          (role too low) or onHarmonize callback not provided. */}
      {onHarmonize != null && harmonizableCount > 0 && (
        <AppTooltip content={
          !canHarmonize
            ? "You need project lead role to run a harmonization sweep"
            : `Open harmonize sweep for ${harmonizableCount} selected cell${harmonizableCount === 1 ? "" : "s"}`
        }>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onHarmonize(selectedCells.filter((c) => c.translated.trim()))}
            disabled={isBusy || !canHarmonize}
            data-testid="selection-harmonize-btn"
          >
            <Wand2 className="mr-1 h-3.5 w-3.5" />
            Harmonize…
            <span className="ml-1 rounded-md bg-muted px-1.5 py-0.5 tabular-nums text-muted-foreground">
              {harmonizableCount}
            </span>
          </Button>
        </AppTooltip>
      )}
        </>
      )}
      <AppTooltip content="Clear selection (Esc)">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={() => clearSelection()}
          disabled={isBusy}
          aria-label="Clear selection"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </AppTooltip>
    </div>
  )
}
