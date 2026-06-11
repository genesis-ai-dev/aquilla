/**
 * FootnoteInline — renders USFM footnotes extracted from a cell's text as a
 * distinct panel immediately below the cell row.
 *
 * Clicking a footnote opens an in-place editor so the translator can modify
 * the footnote text. The edited value is written back via onSave, which the
 * parent (EditorRow) routes through the normal TranslatedEditor commit path.
 *
 * Round-trip safety:
 *   - USFM: SAFE. The cell text retains the raw \f...\f* markers; onSave
 *     splices only the \ft (and translatable) field content in the raw span.
 *   - DOCX: NOT SAFE (see TRACE in src/lib/footnotes/extract.ts). DOCX cells
 *     show a read-only notice rather than an editor.
 *
 * FRO-317
 */

import { useState, useRef, useEffect } from "react"
import type { ExtractedFootnote } from "@/lib/footnotes/extract"
import { cn } from "@/lib/utils"

interface FootnoteInlineProps {
  /** The footnotes extracted from this cell's original (source) text. */
  sourceFootnotes: ExtractedFootnote[]
  /** The footnotes extracted from this cell's translated text.
   *  When present, shown as the editable side. */
  targetFootnotes: ExtractedFootnote[]
  /** Whether the cell is editable (user has write permission). */
  editable: boolean
  /** Whether this cell is from a DOCX file (editing not safe). */
  isDocx: boolean
  /**
   * Called when the user saves a footnote edit.
   * @param footnoteIndex The index of the footnote in the targetFootnotes array.
   * @param newText The new text content for the translatable part of the footnote.
   */
  onSave: (footnoteIndex: number, newText: string) => void
}

export function FootnoteInline({
  sourceFootnotes,
  targetFootnotes,
  editable,
  isDocx,
  onSave,
}: FootnoteInlineProps) {
  const hasSrc = sourceFootnotes.length > 0
  const hasTgt = targetFootnotes.length > 0

  if (!hasSrc && !hasTgt) return null

  return (
    <div
      className="border-t border-border/40 bg-muted/30 px-4 py-2"
      role="region"
      aria-label="Footnotes"
    >
      <div className="mb-1 flex items-center gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Footnotes
        </span>
        {isDocx && (
          <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium text-amber-600 dark:text-amber-400">
            read-only · DOCX round-trip not yet safe
          </span>
        )}
      </div>

      <div className="space-y-1.5">
        {(hasSrc ? sourceFootnotes : targetFootnotes).map((srcFn, i) => {
          const tgtFn = hasTgt ? targetFootnotes[i] : undefined
          return (
            <FootnoteRow
              key={i}
              index={i}
              sourceFn={srcFn}
              targetFn={tgtFn}
              editable={editable && !isDocx && hasTgt}
              onSave={onSave}
            />
          )
        })}
      </div>
    </div>
  )
}

interface FootnoteRowProps {
  index: number
  sourceFn: ExtractedFootnote
  targetFn?: ExtractedFootnote
  editable: boolean
  onSave: (footnoteIndex: number, newText: string) => void
}

function FootnoteRow({ index, sourceFn, targetFn, editable, onSave }: FootnoteRowProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(targetFn?.text ?? "")
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      // Place cursor at end
      const len = inputRef.current.value.length
      inputRef.current.setSelectionRange(len, len)
    }
  }, [editing])

  // Sync draft if targetFn changes externally
  useEffect(() => {
    if (!editing) setDraft(targetFn?.text ?? "")
  }, [targetFn?.text, editing])

  function handleSave() {
    onSave(index, draft)
    setEditing(false)
  }

  function handleCancel() {
    setDraft(targetFn?.text ?? "")
    setEditing(false)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSave()
    }
    if (e.key === "Escape") {
      e.preventDefault()
      handleCancel()
    }
  }

  const callerPill = (
    <span
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-bold text-muted-foreground"
      title="Footnote caller"
      aria-hidden
    >
      {sourceFn.caller === "+" ? "fn" : sourceFn.caller}
    </span>
  )

  return (
    <div className="flex gap-2 text-xs">
      {/* Left: source footnote */}
      <div className="flex min-w-0 flex-1 items-start gap-1.5">
        {callerPill}
        <div className="min-w-0 flex-1">
          {sourceFn.ref && (
            <span className="mr-1 font-mono text-[10px] text-muted-foreground">
              {sourceFn.ref}
            </span>
          )}
          <span className="text-muted-foreground">{sourceFn.text}</span>
        </div>
      </div>

      {/* Right: target footnote (editable) */}
      {targetFn !== undefined && (
        <div className="flex min-w-0 flex-1 items-start gap-1.5 border-l border-border/40 pl-2">
          <div className="min-w-0 flex-1">
            {editing ? (
              <div className="flex flex-col gap-1">
                <textarea
                  ref={inputRef}
                  className={cn(
                    "w-full resize-none rounded border border-border bg-background px-2 py-1 text-xs",
                    "focus:outline-none focus:ring-1 focus:ring-primary/50",
                  )}
                  rows={2}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Translate footnote…"
                  aria-label="Edit footnote"
                />
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={handleSave}
                    className="rounded px-2 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/10"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={handleCancel}
                    className="rounded px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className={cn(
                  "block w-full rounded px-1 py-0.5 text-left text-xs",
                  editable
                    ? "cursor-pointer text-foreground hover:bg-muted/60"
                    : "cursor-default text-muted-foreground",
                  !targetFn.text && editable && "italic text-muted-foreground/60",
                )}
                onClick={() => {
                  if (editable) setEditing(true)
                }}
                aria-label={editable ? "Click to edit footnote" : "Footnote translation"}
                disabled={!editable}
              >
                {targetFn.text || (editable ? "Add translation…" : "—")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
