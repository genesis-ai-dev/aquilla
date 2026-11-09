// AQU-2408 — the cell's own label, at the top of the expansion panel.
//
// A label is a note typed on a line: a section name, a reviewer's mark,
// "needs consultant". It is metadata on the source row (`metadata.cellLabel`,
// written by `cell.label.set`) and never a character or a voice — the voice
// world keeps `cast_name` and the cast gutter. Decision record:
// docs/decisions/0007-cell-labels-are-metadata-never-cast.md.
//
// Three states, decided by the row's gate (src/lib/cell-label-gate.ts):
//   editable  — a single-line field. Enter or blur saves, Escape cancels, a
//               blank value clears. Saving what is already stored emits nothing.
//   read-only — the label as plain text, for members below the tier.
//   absent    — nothing at all, when there is no label and the viewer cannot
//               set one; an empty read-only row would only ask a question the
//               person cannot answer.
//
// The field follows the stored value while nobody is typing in it, so a label
// set on another device lands here too; while typing, the draft wins.

import { useId, useRef, useState, type KeyboardEvent } from "react"
import { Tag } from "lucide-react"
import { Input } from "@/components/ui/input"
import { useT } from "@/lib/i18n/I18nProvider"

/** Long enough for a sentence-length note; the corner truncates far sooner. */
export const CELL_LABEL_MAX_LENGTH = 120

export interface CellLabelRowProps {
  /** The stored label, null for none. */
  label: string | null
  /** True when this viewer may type the label (tier and static floor both pass). */
  editable: boolean
  /** Receives the trimmed label, or null to clear. Unchanged values never reach it. */
  onSave?: (label: string | null) => void
}

export function CellLabelRow({ label, editable, onSave }: CellLabelRowProps) {
  const t = useT()
  const id = useId()
  const [draft, setDraft] = useState(label ?? "")
  const [typing, setTyping] = useState(false)
  // Escape must not let the blur that follows it save the abandoned draft: the
  // blur handler closes over the draft of the render that scheduled it.
  const cancelledRef = useRef(false)
  // The stored label this draft was last reset from. When the prop moves on
  // (saved here, or set on another device) and nobody is typing, the draft
  // follows it — adjusted during render, as React advises for state derived
  // from a changed prop, rather than one render late from an effect.
  const [seenLabel, setSeenLabel] = useState(label)
  if (label !== seenLabel) {
    setSeenLabel(label)
    if (!typing) setDraft(label ?? "")
  }

  if (!editable && !label) return null

  const commit = () => {
    setTyping(false)
    if (cancelledRef.current) {
      cancelledRef.current = false
      return
    }
    const trimmed = draft.trim()
    const next = trimmed === "" ? null : trimmed
    if (next === (label ?? null)) {
      setDraft(label ?? "")
      return
    }
    onSave?.(next)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault()
      e.stopPropagation()
      e.currentTarget.blur()
    } else if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      cancelledRef.current = true
      setDraft(label ?? "")
      e.currentTarget.blur()
    }
  }

  return (
    <div data-testid="cell-label-row" className="mb-1.5 flex items-center gap-2 text-xs">
      <Tag className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      <label htmlFor={id} className="shrink-0 font-medium text-muted-foreground">
        {t("editor.cellLabel.title")}
      </label>
      {editable ? (
        <Input
          id={id}
          data-testid="cell-label-input"
          type="text"
          value={draft}
          placeholder={t("editor.cellLabel.placeholder")}
          aria-label={t("editor.cellLabel.inputAria")}
          maxLength={CELL_LABEL_MAX_LENGTH}
          onFocus={() => setTyping(true)}
          onChange={(e) => {
            setTyping(true)
            setDraft(e.target.value)
          }}
          onBlur={commit}
          onKeyDown={onKeyDown}
          className="h-6 max-w-xs text-xs"
        />
      ) : (
        <span id={id} data-testid="cell-label-text" dir="auto" className="min-w-0 truncate text-foreground">
          {label}
        </span>
      )}
    </div>
  )
}
