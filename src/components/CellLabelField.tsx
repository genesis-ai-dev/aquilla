// AQU-2408 — the field a cell's own label is typed in.
//
// A label is a note typed on a line: a section name, a reviewer's mark,
// "needs consultant". It is metadata on the source row (`metadata.cellLabel`,
// written by `cell.label.set`) and never a character or a voice — the voice
// world keeps `cast_name` and the cast gutter. Decision record:
// docs/decisions/0007-cell-labels-are-metadata-never-cast.md.
//
// The field is typed where the label is read: in the corner label slot of the
// cell, never in the details panel (Matt, 2026-11-12 — the row it replaced sat
// behind the chevron and went unfound). The row mounts it only while someone is
// editing, so it takes the caret as it appears and closes itself when done:
//   Enter or blur — saves and closes. A blank value clears the label; saving
//                   what is already stored emits nothing.
//   Escape        — closes without saving.
//
// Who may open it is the row's gate (src/lib/cell-label-gate.ts); the field
// trusts that it was mounted for someone allowed to type.

import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { Input } from "@/components/ui/input"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

/** Long enough for a sentence-length note; the corner truncates far sooner. */
export const CELL_LABEL_MAX_LENGTH = 120

export interface CellLabelFieldProps {
  /** The stored label, null for none. */
  label: string | null
  /** Receives the trimmed label, or null to clear. Unchanged values never reach it. */
  onSave: (label: string | null) => void
  /** Called once the edit is over, saved or not; the row unmounts the field. */
  onClose: () => void
  className?: string
}

export function CellLabelField({ label, onSave, onClose, className }: CellLabelFieldProps) {
  const t = useT()
  const [draft, setDraft] = useState(label ?? "")
  const inputRef = useRef<HTMLInputElement>(null)
  // Escape must not let the blur that follows it save the abandoned draft.
  const cancelledRef = useRef(false)

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    // An existing label is selected whole, so typing replaces it.
    input.select()
  }, [])

  const finish = () => {
    if (!cancelledRef.current) {
      const trimmed = draft.trim()
      const next = trimmed === "" ? null : trimmed
      if (next !== (label ?? null)) onSave(next)
    }
    onClose()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // The field sits inside the cell: no key typed here is the row's to act on.
    e.stopPropagation()
    if (e.key === "Enter") {
      e.preventDefault()
      e.currentTarget.blur()
    } else if (e.key === "Escape") {
      e.preventDefault()
      cancelledRef.current = true
      e.currentTarget.blur()
    }
  }

  return (
    <Input
      ref={inputRef}
      data-testid="cell-label-input"
      type="text"
      dir="auto"
      value={draft}
      placeholder={t("editor.cellLabel.placeholder")}
      aria-label={t("editor.cellLabel.inputAria")}
      maxLength={CELL_LABEL_MAX_LENGTH}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={finish}
      onKeyDown={onKeyDown}
      // A click in the field is not a click on the cell around it.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className={cn("h-5 w-44 max-w-[60%] shrink-0 rounded-sm bg-background px-1.5 py-0 text-xs text-foreground md:text-xs", className)}
    />
  )
}
