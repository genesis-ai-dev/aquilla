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
import { Languages, Loader2, Sparkles, X } from "lucide-react"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { clearSelection, MAX_SELECTED, useSelectedIds } from "@/lib/audio/selection"
import { emitCellValidate, emitCellUnvalidate } from "@/lib/sync/events-emit"

interface Props {
  project: ProjectRecord
  cells: CellData[]
  session: FrontierSession | null
  username: string
  completeSingle?: (cell: CellData) => Promise<void> | void
  completeBatch?: (cells: CellData[]) => Promise<void> | void
  /** Audio mode surfaces "Voice together" instead of Translate/Validate. */
  audioMode?: boolean
  /** Synthesize the selected cells as one continuous clip + slice per cell. */
  onVoiceTogether?: (cells: CellData[]) => Promise<void> | void
}

type Running =
  | { kind: "idle" }
  | { kind: "translate" }
  | { kind: "validate" }
  | { kind: "voice" }

export function SelectionBar({ project, cells, username, completeBatch, audioMode, onVoiceTogether }: Props) {
  const selected = useSelectedIds()
  const [running, setRunning] = useState<Running>({ kind: "idle" })
  const [toastMsg, setToastMsg] = useState<string | null>(null)

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

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg)
    setTimeout(() => setToastMsg(null), 3000)
  }, [])

  const selectedCells = useMemo(() => {
    const wanted = selected
    return cells.filter((c) => wanted.has(c.id)).slice(0, MAX_SELECTED)
  }, [cells, selected])

  const missingCount = useMemo(
    () => selectedCells.filter((c) => !c.translated.trim() && c.original?.trim()).length,
    [selectedCells],
  )
  const validatableCount = useMemo(
    () => selectedCells.filter(
      (c) => c.translated.trim() && !c.activeValidators.includes(username),
    ).length,
    [selectedCells, username],
  )
  const unvalidatableCount = useMemo(
    () => selectedCells.filter(
      (c) => c.translated.trim() && c.activeValidators.includes(username),
    ).length,
    [selectedCells, username],
  )
  const allHaveTranslation = selectedCells.length > 0 && selectedCells.every((c) => c.translated.trim())
  const voiceableCount = useMemo(
    () => selectedCells.filter((c) => c.type !== "paratext" && c.translated.trim()).length,
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
        if (!cell.translated.trim()) continue
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
      showToast(msg)
    } finally {
      setRunning({ kind: "idle" })
    }
  }, [selectedCells, username, validatableCount, isBusy, project.id])

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
      showToast(`Removed validations from ${removed} cell${removed === 1 ? "" : "s"}`)
    } finally {
      setRunning({ kind: "idle" })
    }
  }, [selectedCells, username, unvalidatableCount, isBusy, project.id])

  if (selectedCells.length === 0) return null

  return (
    <>
    {toastMsg && (
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed bottom-16 left-1/2 z-40 -translate-x-1/2 rounded-lg bg-card px-4 py-2 text-xs font-medium shadow-neu-lg"
      >
        {toastMsg}
      </div>
    )}
    <div
      className={cn(
        "pointer-events-auto fixed left-1/2 z-30 flex -translate-x-1/2 items-center gap-2",
        "bottom-4 rounded-full bg-card px-4 py-2 text-xs shadow-neu-lg",
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
      <div className="mx-1 h-5 w-px rounded-full shadow-neu-inset" />
      {audioMode && (
        <Button
          type="button"
          size="sm"
          variant="default"
          onClick={onVoice}
          disabled={isBusy || voiceableCount < 2 || !onVoiceTogether}
          title={
            !onVoiceTogether ? "Voicing isn't available here" :
            voiceableCount < 2 ? "Select at least two translated lines" :
            `Voice ${voiceableCount} lines as one clip`
          }
        >
          {running.kind === "voice" ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="mr-1 h-3.5 w-3.5" />
          )}
          Voice together
          {voiceableCount > 1 && (
            <span className="ml-1 rounded-full bg-primary-foreground/20 px-1.5 py-0.5 tabular-nums text-primary-foreground">
              {Math.min(voiceableCount, 12)}
            </span>
          )}
        </Button>
      )}
      {!audioMode && (
        <>
      <Button
        type="button"
        size="sm"
        variant="default"
        onClick={onTranslate}
        disabled={isBusy || missingCount === 0 || !completeBatch}
        title={
          !completeBatch ? "Translation isn't configured for this project" :
          missingCount === 0 ? "All selected cells already have translations" :
          `Translate ${missingCount} missing`
        }
      >
        {running.kind === "translate" ? (
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
        ) : (
          <Languages className="mr-1 h-3.5 w-3.5" />
        )}
        Translate
        {missingCount > 0 && allHaveTranslation === false && (
          <span className="ml-1 rounded-full bg-primary-foreground/20 px-1.5 py-0.5 tabular-nums text-primary-foreground">
            {missingCount}
          </span>
        )}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={onValidate}
        disabled={isBusy || validatableCount === 0}
        title={
          validatableCount === 0
            ? "Nothing to validate — selected cells are empty or already validated by you"
            : `Validate ${validatableCount} cell${validatableCount === 1 ? "" : "s"}`
        }
      >
        {running.kind === "validate" ? (
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
        ) : null}
        Validate
        {validatableCount > 0 && (
          <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 tabular-nums text-muted-foreground">
            {validatableCount}
          </span>
        )}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={onUnvalidate}
        disabled={isBusy || unvalidatableCount === 0}
        title={
          unvalidatableCount === 0
            ? "No cells have your validation"
            : `Remove your validation from ${unvalidatableCount} cell${unvalidatableCount === 1 ? "" : "s"}`
        }
      >
        Remove my validations
        {unvalidatableCount > 0 && (
          <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 tabular-nums text-muted-foreground">
            {unvalidatableCount}
          </span>
        )}
      </Button>
        </>
      )}
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        onClick={() => clearSelection()}
        disabled={isBusy}
        aria-label="Clear selection"
        title="Clear selection (Esc)"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
    </>
  )
}
