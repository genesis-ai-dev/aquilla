/**
 * USFM footnote surfaces.
 *
 * Stored cell text keeps raw \f...\f* markers for lossless round-trip. These
 * components render those markers as either inline child rows or a read-only
 * bottom tray without introducing a separate footnote storage model.
 */

import { useState, useEffect, type ReactNode } from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { extractUsfmFootnotes, type ExtractedFootnote } from "@/lib/footnotes/extract"
import type { VisibleFootnoteEntry } from "@/lib/footnotes/types"
import { cn } from "@/lib/utils"
import { FootnoteTextEditor, renderFootnoteRichText } from "./FootnoteTextEditor"

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
  /** Return false when the save failed (e.g. stale footnote index) so the editor stays open. FRO-472 */
  onSave: (footnoteIndex: number, newText: string) => boolean | void
  /** Called when the user confirms deleting the full target footnote marker. */
  onDelete?: (footnoteIndex: number) => void
  /** Creates a target footnote from the corresponding source footnote. */
  onCreateTarget?: (sourceFootnote: ExtractedFootnote) => void
  /** Number of numeric footnotes before this cell in the current chapter/file. */
  numberOffset?: number
  /** Target footnote marker currently hovered/focused inside the cell. */
  activeFootnoteIndex?: number | null
  /** Render as a compact block inside the target cell instead of a full-width band. */
  compact?: boolean
}

export function FootnoteInline({
  sourceFootnotes,
  targetFootnotes,
  editable,
  isDocx,
  onSave,
  onDelete,
  onCreateTarget,
  numberOffset = 0,
  activeFootnoteIndex = null,
  compact = false,
}: FootnoteInlineProps) {
  const hasSrc = sourceFootnotes.length > 0
  const hasTgt = targetFootnotes.length > 0

  if (!hasSrc && !hasTgt) return null

  if (compact) {
    const rowsSourceFootnotes = hasTgt ? [] : sourceFootnotes
    return (
      <div
        className="mt-1 rounded-md border border-border/40 bg-muted/20 px-1.5 py-0.5"
        role="region"
        aria-label="Footnotes"
      >
        <FootnoteSurfaceHeader
          title="Footnotes"
          isDocx={isDocx}
          count={targetFootnotes.length || sourceFootnotes.length}
          className="mb-0.5"
        />
        <FootnoteRows
          sourceFootnotes={rowsSourceFootnotes}
          targetFootnotes={targetFootnotes}
          editable={editable && !isDocx && hasTgt}
          canCreateTarget={editable && !isDocx}
          onSave={onSave}
          onDelete={onDelete}
          onCreateTarget={onCreateTarget}
          numberOffset={numberOffset}
          activeFootnoteIndex={activeFootnoteIndex}
          targetOnlyLayout="fill"
          compact
        />
      </div>
    )
  }

  return (
    <div
      className="grid items-start gap-1.5 border-t border-border/40 bg-muted/20 px-4 py-1.5 md:grid-cols-[minmax(0,1fr)_minmax(18rem,1fr)]"
      role="region"
      aria-label="Footnotes"
    >
      <FootnoteSurfaceHeader
        title="Footnotes"
        isDocx={isDocx}
        count={targetFootnotes.length || sourceFootnotes.length}
      />
      <div className="min-w-0 md:border-l md:border-border/40 md:pl-2.5">
        <FootnoteRows
          sourceFootnotes={sourceFootnotes}
          targetFootnotes={targetFootnotes}
          editable={editable && !isDocx && hasTgt}
          canCreateTarget={editable && !isDocx}
          onSave={onSave}
          onDelete={onDelete}
          onCreateTarget={onCreateTarget}
          numberOffset={numberOffset}
          activeFootnoteIndex={activeFootnoteIndex}
          targetOnlyLayout="fill"
        />
      </div>
    </div>
  )
}

export function FootnotesTray({
  entries,
  className,
  editable = false,
  onSave,
  onDelete,
  onClose,
}: {
  entries: VisibleFootnoteEntry[]
  className?: string
  editable?: boolean
  /** Return false when the save failed (e.g. stale footnote index) so the editor stays open. FRO-472 */
  onSave?: (cellId: string, footnoteIndex: number, newText: string) => boolean | void
  onDelete?: (cellId: string, footnoteIndex: number) => void
  onClose?: () => void
}) {
  const visibleEntries = entries.filter((entry) => entry.targetFootnotes.length > 0)
  const visibleFootnoteCount = visibleEntries.reduce((sum, entry) => sum + entry.targetFootnotes.length, 0)

  return (
    <section
      className={cn(
        "border-t border-border bg-background/95 shadow-[0_-10px_30px_rgba(15,23,42,0.06)] backdrop-blur supports-[backdrop-filter]:bg-background/85",
        className,
      )}
      aria-label="Visible footnotes"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-1.5">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-foreground">
            Footnotes
          </div>
          <div className="truncate text-[11px] text-muted-foreground/80">
            Updates as the editor scrolls
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Badge variant="secondary" className="text-[10px]">
            {visibleFootnoteCount}
          </Badge>
          {onClose && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close footnotes tray"
              onClick={onClose}
            >
              <X />
            </Button>
          )}
        </div>
      </div>

      <div className="h-[min(24vh,220px)] overflow-y-auto overscroll-contain">
        {visibleEntries.length === 0 ? (
          <div className="px-4 py-5 text-sm text-muted-foreground">
            No footnotes in the visible rows.
          </div>
        ) : (
          <>
            {visibleEntries.map((entry) => (
              <article
                key={entry.cellId}
                className="grid gap-2 border-b border-border/50 px-4 py-2 last:border-b-0 md:grid-cols-[minmax(4rem,0.45fr)_minmax(18rem,0.55fr)]"
              >
                <div className="flex min-w-0 items-start gap-2 pt-0.5">
                  <Badge variant="secondary" className="text-[10px]">
                    {entry.cellLabel}
                  </Badge>
                  {entry.cellRef && (
                    <span className="truncate text-[11px] text-muted-foreground">
                      {entry.cellRef}
                    </span>
                  )}
                </div>
                <div className="min-w-0 md:border-l md:border-border/40 md:pl-3">
                  <FootnoteRows
                    sourceFootnotes={[]}
                    targetFootnotes={entry.targetFootnotes}
                    editable={editable && !entry.isDocx}
                    onSave={(footnoteIndex, newText) => onSave?.(entry.cellId, footnoteIndex, newText)}
                    onDelete={onDelete ? (footnoteIndex) => onDelete(entry.cellId, footnoteIndex) : undefined}
                    numberOffset={entry.numberOffset}
                    activeFootnoteIndex={entry.activeFootnoteIndex}
                    targetOnlyLayout="fill"
                  />
                </div>
              </article>
            ))}
          </>
        )}
      </div>
    </section>
  )
}

function FootnoteSurfaceHeader({
  title,
  isDocx,
  count,
  className,
}: {
  title: string
  isDocx: boolean
  count?: number
  className?: string
}) {
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </span>
      {typeof count === "number" && count > 0 && (
        <Badge className="h-auto border-transparent bg-primary/10 px-1.5 text-[9px] font-bold text-primary">
          {count}
        </Badge>
      )}
      {isDocx && (
        <Badge className="h-auto border-transparent bg-amber-500/10 px-1.5 text-[9px] font-medium text-amber-600 dark:text-amber-400">
          read-only · DOCX round-trip not yet safe
        </Badge>
      )}
    </div>
  )
}

function FootnoteRows({
  sourceFootnotes,
  targetFootnotes,
  editable,
  canCreateTarget,
  onSave,
  onDelete,
  onCreateTarget,
  numberOffset = 0,
  activeFootnoteIndex = null,
  targetOnlyLayout = "right-half",
  compact = false,
}: {
  sourceFootnotes: ExtractedFootnote[]
  targetFootnotes: ExtractedFootnote[]
  editable: boolean
  canCreateTarget?: boolean
  /** Return false when the save failed (e.g. stale footnote index) so the editor stays open. FRO-472 */
  onSave: (footnoteIndex: number, newText: string) => boolean | void
  onDelete?: (footnoteIndex: number) => void
  onCreateTarget?: (sourceFootnote: ExtractedFootnote) => void
  numberOffset?: number
  activeFootnoteIndex?: number | null
  targetOnlyLayout?: "right-half" | "fill"
  compact?: boolean
}) {
  const rowCount = Math.max(sourceFootnotes.length, targetFootnotes.length)

  return (
    <div className={cn(compact ? "space-y-0.5" : "space-y-1")}>
      {Array.from({ length: rowCount }, (_, i) => (
        <FootnoteRow
          key={`${sourceFootnotes[i]?.index ?? "target"}-${targetFootnotes[i]?.index ?? "source"}-${i}`}
          index={i}
          sourceFn={sourceFootnotes[i]}
          targetFn={targetFootnotes[i]}
          editable={editable}
          canCreateTarget={canCreateTarget}
          active={activeFootnoteIndex === i}
          numberOffset={numberOffset}
          onSave={onSave}
          onDelete={onDelete}
          onCreateTarget={onCreateTarget}
          targetOnlyLayout={targetOnlyLayout}
          compact={compact}
        />
      ))}
    </div>
  )
}

interface FootnoteRowProps {
  index: number
  sourceFn?: ExtractedFootnote
  targetFn?: ExtractedFootnote
  editable: boolean
  canCreateTarget?: boolean
  active?: boolean
  numberOffset: number
  targetOnlyLayout: "right-half" | "fill"
  compact?: boolean
  /** Return false when the save failed (e.g. stale footnote index) so the editor stays open. FRO-472 */
  onSave: (footnoteIndex: number, newText: string) => boolean | void
  onDelete?: (footnoteIndex: number) => void
  onCreateTarget?: (sourceFootnote: ExtractedFootnote) => void
}

function FootnoteRow({
  index,
  sourceFn,
  targetFn,
  editable,
  canCreateTarget,
  active,
  numberOffset,
  targetOnlyLayout,
  compact = false,
  onSave,
  onDelete,
  onCreateTarget,
}: FootnoteRowProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(targetFn?.text ?? "")
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [saveError, setSaveError] = useState(false)

  useEffect(() => {
    if (!editing) {
      setDraft(targetFn?.text ?? "")
      setConfirmDelete(false)
      setSaveError(false)
    }
  }, [targetFn?.text, editing])

  function handleSave() {
    // onSave returns false when the splice could not locate the footnote
    // (cell text changed underneath the editor). Keep the editor open with
    // the draft intact instead of silently dropping the edit (FRO-472).
    if (onSave(index, draft) === false) {
      setSaveError(true)
      return
    }
    setSaveError(false)
    setEditing(false)
    setConfirmDelete(false)
  }

  function handleCancel() {
    setDraft(targetFn?.text ?? "")
    setEditing(false)
    setConfirmDelete(false)
    setSaveError(false)
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

  function handleDelete() {
    if (!targetFn || !onDelete) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    onDelete(index)
    setEditing(false)
    setConfirmDelete(false)
  }

  const visibleFootnote = targetFn ?? sourceFn
  const callerLabel = footnoteDisplayLabel(visibleFootnote, index, numberOffset)
  const targetContent = (
    <div className="min-w-0 flex-1">
      {targetFn === undefined ? (
        sourceFn && canCreateTarget && onCreateTarget ? (
          <button
            type="button"
            className="rounded px-1 py-0.5 text-left text-xs font-medium text-primary hover:bg-primary/10"
            onClick={() => onCreateTarget(sourceFn)}
          >
            Add target footnote
          </button>
        ) : (
          <span className="italic text-muted-foreground/70">No target footnote</span>
        )
      ) : editing ? (
        <div className="flex flex-col gap-1">
          <FootnoteTextEditor
            className="text-xs"
            rows={2}
            value={draft}
            onChange={(next) => {
              setDraft(next)
              if (confirmDelete && next.trim().length > 0) setConfirmDelete(false)
            }}
            onKeyDown={handleKeyDown}
            placeholder="Translate footnote..."
            ariaLabel="Edit footnote"
          />
          {saveError && (
            <p role="alert" className="text-[10px] text-destructive">
              Couldn't save — this footnote changed while you were editing. Copy your text, cancel, and reopen it.
            </p>
          )}
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
            {onDelete && (
              <button
                type="button"
                onClick={handleDelete}
                className={cn(
                  "ml-auto rounded px-2 py-0.5 text-[10px] font-medium",
                  confirmDelete
                    ? "bg-destructive/15 text-destructive hover:bg-destructive/20"
                    : "text-destructive hover:bg-destructive/10",
                )}
              >
                {confirmDelete ? "I'm sure" : "Delete"}
              </button>
            )}
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={cn(
            "block w-full rounded text-left text-xs",
            compact ? "px-0.5 py-0 leading-snug" : "px-1 py-0.5",
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
          {targetFn.text || (editable ? "Add translation..." : "Empty target footnote")}
        </button>
      )}
    </div>
  )

  if (!sourceFn && targetFn) {
    return (
      <div
        className={cn(
          "text-xs transition-colors",
          targetOnlyLayout === "right-half" && "flex justify-end rounded-md px-1 py-0.5 hover:bg-primary/5 focus-within:bg-primary/5",
          active && "bg-primary/10 ring-1 ring-primary/20",
        )}
      >
        <div
          className={cn(
            "flex min-w-0 items-start rounded-md bg-primary/5 transition-colors hover:bg-primary/10 focus-within:bg-primary/10",
            compact ? "gap-1 px-1.5 py-0.5 ring-1 ring-primary/5" : "gap-1.5 px-2 py-0.5 ring-1 ring-primary/10",
            targetOnlyLayout === "right-half" && "w-full md:w-[calc(50%-0.25rem)]",
            targetOnlyLayout === "fill" && "w-full",
          )}
        >
          <span className="sr-only">Target footnote</span>
          <FootnoteMarkerBadge label={callerLabel} active />
          {targetContent}
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        "grid gap-2 rounded-md px-1 py-0.5 text-xs transition-colors hover:bg-primary/5 focus-within:bg-primary/5 md:grid-cols-2",
        active && "bg-primary/10 ring-1 ring-primary/20",
      )}
    >
      <div className="flex min-w-0 items-start gap-1.5">
        <FootnoteMarkerBadge label={callerLabel} />
        {sourceFn ? (
          <FootnoteText footnote={sourceFn} muted />
        ) : (
          <span className="italic text-muted-foreground/60">No source footnote</span>
        )}
      </div>

      <div className="flex min-w-0 items-start gap-1.5 border-border/40 md:border-l md:pl-2">
        <span className="sr-only">Target footnote</span>
        {targetFn && <FootnoteMarkerBadge label={callerLabel} active />}
        {targetContent}
      </div>
    </div>
  )
}

export function FootnotedTextValue({
  value,
  numberOffset = 0,
  showFootnotes = false,
  className,
  emptyLabel = "(empty)",
}: {
  value: string
  numberOffset?: number
  showFootnotes?: boolean
  className?: string
  emptyLabel?: ReactNode
}) {
  const footnotes = extractUsfmFootnotes(value)
  const content: ReactNode[] = []
  let cursor = 0

  footnotes.forEach((footnote, index) => {
    if (footnote.index > cursor) {
      content.push(value.slice(cursor, footnote.index))
    }
    content.push(
      <sup
        key={`fn-${footnote.index}-${index}`}
        className="mx-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-md bg-primary/15 px-0.5 align-super text-[9px] font-bold leading-none text-primary"
      >
        {footnoteDisplayLabel(footnote, index, numberOffset)}
      </sup>,
    )
    cursor = footnote.index + footnote.raw.length
  })

  if (cursor < value.length) content.push(value.slice(cursor))

  return (
    <div className={cn("min-w-0", className)}>
      <div className="whitespace-pre-wrap">
        {content.length > 0 ? content : <span className="italic text-muted-foreground">{emptyLabel}</span>}
      </div>
      {showFootnotes && footnotes.length > 0 && (
        <div className="mt-1 border-t border-border/40 pt-1">
          <FootnoteRows
            sourceFootnotes={[]}
            targetFootnotes={footnotes}
            editable={false}
            onSave={() => undefined}
            numberOffset={numberOffset}
          />
        </div>
      )}
    </div>
  )
}

function FootnoteMarkerBadge({ label, active }: { label: string; active?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-md px-1 text-[9px] font-bold",
        active ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
      )}
      aria-hidden
    >
      {label}
    </span>
  )
}

function footnoteDisplayLabel(
  footnote: ExtractedFootnote | undefined,
  index: number,
  numberOffset: number,
): string {
  const caller = footnote?.caller.trim()
  if (caller && caller !== "+" && caller !== "-") return caller
  return String(numberOffset + index + 1)
}

function FootnoteText({ footnote, muted }: { footnote: ExtractedFootnote; muted?: boolean }) {
  return (
    <div className="min-w-0 flex-1">
      {footnote.ref && (
        <span className="mr-1 font-mono text-[10px] text-muted-foreground">
          {footnote.ref}
        </span>
      )}
      <span className={cn(muted ? "text-muted-foreground" : "text-foreground")}>
        {footnote.text ? renderFootnoteRichText(footnote.text) : <span className="italic text-muted-foreground/70">Empty footnote</span>}
      </span>
    </div>
  )
}
