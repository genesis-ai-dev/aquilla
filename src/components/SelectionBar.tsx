// Floating action bar that appears whenever the user has multi-selected
// cells. Surfaces bulk Translate / Validate / Generate Audio / Both.
//
// Synth uses the project's default voice; users can also drag a voice
// chip from the VoiceBar onto any selected cell to synth with that voice.

// Phase 2c-gamma: bulk synth + Y.Doc-driven validate are gone. The
// selection bar still surfaces the count + Translate (via completeBatch,
// which now drives the LLM stream without writing the result back) so the
// multi-select UX stays useful. Validate and Speak/Translate+Speak are
// disabled until the audio-attachment + validate-via-events grammars land.

import { useCallback, useEffect, useMemo, useState } from "react"
import { Languages, Loader2, X } from "lucide-react"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { clearSelection, MAX_SELECTED, useSelectedIds } from "@/lib/audio/selection"
import { emitCellValidate } from "@/lib/sync/events-emit"

interface Props {
  project: ProjectRecord
  cells: CellData[]
  session: FrontierSession | null
  username: string
  completeSingle?: (cell: CellData) => Promise<void> | void
  completeBatch?: (cells: CellData[]) => Promise<void> | void
}

type Running =
  | { kind: "idle" }
  | { kind: "translate" }
  | { kind: "validate" }

export function SelectionBar({ project, cells, username, completeBatch }: Props) {
  const selected = useSelectedIds()
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
  const allHaveTranslation = selectedCells.length > 0 && selectedCells.every((c) => c.translated.trim())
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

  const onValidate = useCallback(() => {
    if (isBusy) return
    if (validatableCount === 0) return
    setRunning({ kind: "validate" })
    try {
      for (const cell of selectedCells) {
        if (!cell.translated.trim()) continue
        if (cell.activeValidators.includes(username)) continue
        if (!cell.targetEventId || !project.id) continue
        void emitCellValidate({
          projectId: project.id,
          fileId: cell.fileId,
          cellId: cell.id,
          author: username,
          editEventId: cell.targetEventId,
        })
      }
    } finally {
      setRunning({ kind: "idle" })
    }
  }, [selectedCells, username, validatableCount, isBusy, project.id])

  if (selectedCells.length === 0) return null

  return (
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
  )
}
