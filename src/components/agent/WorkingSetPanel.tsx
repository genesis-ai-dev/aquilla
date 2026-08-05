/**
 * WorkingSetPanel.tsx — the workbench's review editor (agent-mode-v2, MTPE
 * loop): the cells the agent is touching as aligned source/target rows.
 * Pending drafts are EDITABLE IN PLACE — accept commits what's in the box,
 * not what the agent proposed — with rule lint re-running as you type.
 * Decided rows keep a state stripe (accepted / edited & accepted / rejected)
 * so the grid reads as a record of the session.
 *
 * Keyboard cadence: j/k move · Enter accept & next · type to edit ·
 * x reject · Shift+A accept remaining.
 */

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react"
import { AlertTriangle, ArrowUpRight, Check, ListChecks, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { pendingRows, proposalRowKey, type WorkingSetRow } from "@/lib/agent/working-set"

const STATUS_STYLE: Record<string, string> = {
  untranslated: "text-muted-foreground",
  drafted: "text-sky-600 dark:text-sky-400",
  stale: "text-amber-600 dark:text-amber-400",
  validated: "text-emerald-600 dark:text-emerald-500",
  flagged: "text-destructive",
}

/** Stripe + label per row lifecycle state (the mock's left border). */
function rowStripe(row: WorkingSetRow, editing: boolean): string {
  if (editing) return "border-l-sky-400 bg-accent/30"
  if (row.outcome === "accepted" || row.outcome === "edited") return "border-l-emerald-500"
  if (row.outcome === "undone") return "border-l-amber-500 opacity-70"
  if (row.outcome === "rejected") return "border-l-transparent opacity-55"
  if (row.proposed !== undefined) return "border-l-sky-800"
  return "border-l-transparent"
}

export interface WorkingSetPanelHandle {
  /** Focus the first undecided pending row (receipt "Review" jump). */
  focusFirstPending: () => void
}

export interface WorkingSetPanelProps {
  rows: WorkingSetRow[]
  /** Apply one staged row with the (possibly edited) text. */
  onAccept?: (row: WorkingSetRow, value: string) => void | Promise<void>
  onReject?: (row: WorkingSetRow) => void
  /** Apply every pending row; `valueFor` resolves each row's edited text. */
  onAcceptAll?: (valueFor: (row: WorkingSetRow) => string) => void | Promise<void>
  /** Jump the editor to a cell. */
  onJumpToCell?: (fileId: string, cellId: string) => void
  /** Rule lint for a pending row's current text — badge labels, [] = clean. */
  lintRow?: (row: WorkingSetRow, text: string) => string[]
  /** Disables the apply buttons while an apply is in flight. */
  busy?: boolean
  /** Hide source when it already has a dedicated workbench pane. */
  showSource?: boolean
  /** Pane heading; defaults to the legacy label. */
  title?: string
  /** Optional language label beside the heading. */
  language?: string | null
}

const rowKey = (row: WorkingSetRow): string =>
  row.proposalId ? proposalRowKey(row.proposalId, row.cellId) : row.cellId

export const WorkingSetPanel = forwardRef<WorkingSetPanelHandle, WorkingSetPanelProps>(
  function WorkingSetPanel({
    rows,
    onAccept,
    onReject,
    onAcceptAll,
    onJumpToCell,
    lintRow,
    busy,
    showSource = true,
    title = "Working set",
    language,
  }, ref) {
    const pending = useMemo(() => pendingRows(rows), [rows])
    const [focusIdx, setFocusIdx] = useState(0)
    const [editing, setEditing] = useState(false)
    // Draft edits survive moving between rows (keyed per proposal row), so a
    // half-fixed cell isn't lost by a stray j/k.
    const [edits, setEdits] = useState<ReadonlyMap<string, string>>(new Map())
    const containerRef = useRef<HTMLDivElement>(null)

    // Keep focus index in range as rows change.
    useEffect(() => {
      setFocusIdx((i) => Math.min(i, Math.max(rows.length - 1, 0)))
    }, [rows.length])

    const valueFor = useCallback(
      (row: WorkingSetRow): string => edits.get(rowKey(row)) ?? row.proposed ?? "",
      [edits],
    )

    const focusRow = useCallback((idx: number) => {
      setFocusIdx(idx)
      setEditing(false)
      containerRef.current?.focus()
      containerRef.current
        ?.querySelector(`[data-row-index="${idx}"]`)
        ?.scrollIntoView({ block: "nearest" })
    }, [])

    useImperativeHandle(
      ref,
      () => ({
        focusFirstPending: () => {
          const idx = rows.findIndex((r) => r.proposed !== undefined && r.stagedEvent)
          if (idx >= 0) focusRow(idx)
        },
      }),
      [rows, focusRow],
    )

    /** Accept a row and advance focus to the next pending one. */
    const acceptAndAdvance = useCallback(
      (idx: number) => {
        const row = rows[idx]
        if (!row || row.proposed === undefined || !onAccept || busy) return
        void onAccept(row, valueFor(row))
        setEditing(false)
        const next = rows.findIndex(
          (r, i) => i !== idx && i > idx && r.proposed !== undefined && r.stagedEvent,
        )
        const wrap = next === -1 ? rows.findIndex((r, i) => i !== idx && r.proposed !== undefined && r.stagedEvent) : next
        if (wrap >= 0) focusRow(wrap)
        else containerRef.current?.focus()
      },
      [rows, onAccept, busy, valueFor, focusRow],
    )

    const rejectAndAdvance = useCallback(
      (idx: number) => {
        const row = rows[idx]
        if (!row || row.proposed === undefined || !onReject) return
        onReject(row)
        setEditing(false)
        const next = rows.findIndex((r, i) => i > idx && r.proposed !== undefined && r.stagedEvent)
        if (next >= 0) focusRow(next)
      },
      [rows, onReject, focusRow],
    )

    const focused = rows[focusIdx]
    const focusedPending = focused && focused.proposed !== undefined && focused.stagedEvent

    const handleKeyDown = (e: React.KeyboardEvent) => {
      // While editing, the textarea owns the keyboard (it stops propagation
      // for the keys it handles); anything that bubbles here is ignored.
      if (editing) return
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault()
        focusRow(Math.min(focusIdx + 1, rows.length - 1))
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault()
        focusRow(Math.max(focusIdx - 1, 0))
      } else if (e.key === "Enter" && focusedPending) {
        e.preventDefault()
        acceptAndAdvance(focusIdx)
      } else if (e.key === "x" && focusedPending) {
        e.preventDefault()
        rejectAndAdvance(focusIdx)
      } else if (e.key === "A" && e.shiftKey && pending.length > 0 && onAcceptAll && !busy) {
        e.preventDefault()
        void onAcceptAll(valueFor)
      } else if (
        focusedPending &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        (e.key.length === 1 || e.key === "e" || e.key === "F2")
      ) {
        // Type to edit: a printable key opens the editor seeded with the
        // draft and appends the typed character (e/F2 just open it).
        e.preventDefault()
        const key = rowKey(focused)
        if (e.key.length === 1 && e.key !== "e") {
          setEdits((prev) => new Map(prev).set(key, valueFor(focused) + e.key))
        }
        setEditing(true)
      }
    }

    if (rows.length === 0) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center text-muted-foreground">
          <ListChecks className="h-5 w-5" />
          <p className="text-xs">
            {showSource
              ? "The cells the agent reads and drafts appear here — source on the left, translation on the right, with staged drafts to accept or reject."
              : "The agent’s staged drafts appear here for you to edit, accept, or reject."}
          </p>
        </div>
      )
    }

    return (
      <div
        ref={containerRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        role="region"
        aria-label={title === "Working set" ? "Working set" : `${title} review pane`}
        className="flex h-full min-h-0 flex-col outline-none"
      >
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-3">
          <span className="text-[11px] font-semibold tracking-tight text-foreground/90">{title}</span>
          <span className="truncate text-[10px] text-muted-foreground">
            {[language || null, `${rows.length} cell${rows.length === 1 ? "" : "s"}`, pending.length > 0 ? `${pending.length} to review` : null]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {pending.length > 0 && onAcceptAll && (
            <AppTooltip content="Accept every pending draft, with your edits (Shift+A)">
              <Button
                type="button"
                size="sm"
                className="ml-auto h-6 text-[11px]"
                disabled={busy}
                onClick={() => void onAcceptAll(valueFor)}
              >
                <Check data-icon="inline-start" />
                Accept remaining ({pending.length})
              </Button>
            </AppTooltip>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows.map((row, idx) => (
            <WorkingSetRowView
              key={row.cellId}
              row={row}
              index={idx}
              focused={idx === focusIdx}
              editing={editing && idx === focusIdx}
              editValue={valueFor(row)}
              busy={busy}
              lintRow={lintRow}
              onFocus={() => setFocusIdx(idx)}
              onStartEdit={() => {
                setFocusIdx(idx)
                setEditing(true)
              }}
              onEditChange={(value) => {
                const key = rowKey(row)
                setEdits((prev) => new Map(prev).set(key, value))
              }}
              onEditRevert={() => {
                setEdits((prev) => {
                  const next = new Map(prev)
                  next.delete(rowKey(row))
                  return next
                })
                setEditing(false)
                containerRef.current?.focus()
              }}
              onAccept={onAccept ? () => acceptAndAdvance(idx) : undefined}
              onReject={onReject ? () => rejectAndAdvance(idx) : undefined}
              onJumpToCell={onJumpToCell}
              showSource={showSource}
            />
          ))}
        </div>

        <div className="border-t px-3 py-1 text-[10px] text-muted-foreground">
          j/k move · Enter accept & next · type to edit · x reject · Shift+A accept remaining
        </div>
      </div>
    )
  },
)

// ── Row ─────────────────────────────────────────────────────────────────────

interface RowViewProps {
  row: WorkingSetRow
  index: number
  focused: boolean
  editing: boolean
  /** Current text for a pending row (edit if any, else the draft). */
  editValue: string
  busy?: boolean
  lintRow?: (row: WorkingSetRow, text: string) => string[]
  onFocus: () => void
  onStartEdit: () => void
  onEditChange: (value: string) => void
  onEditRevert: () => void
  onAccept?: () => void
  onReject?: () => void
  onJumpToCell?: (fileId: string, cellId: string) => void
  showSource: boolean
}

const OUTCOME_LABEL: Record<string, string> = {
  accepted: "✓ accepted",
  edited: "✓ edited & accepted",
  rejected: "rejected",
  undone: "↩ undone",
}

const WorkingSetRowView = memo(function WorkingSetRowView({
  row, index, focused, editing, editValue, busy, lintRow,
  onFocus, onStartEdit, onEditChange, onEditRevert, onAccept, onReject, onJumpToCell, showSource,
}: RowViewProps) {
  const isPending = row.proposed !== undefined && row.stagedEvent
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Lint the row's CURRENT text (re-runs as the user types).
  const lint = useMemo(
    () => (isPending && lintRow ? lintRow(row, editValue) : []),
    [isPending, lintRow, row, editValue],
  )

  useEffect(() => {
    if (editing) {
      const el = textareaRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }
    }
  }, [editing])

  const stateLabel = row.outcome
    ? OUTCOME_LABEL[row.outcome]
    : isPending
      ? "draft"
      : row.status
  const stateClass = row.outcome
    ? row.outcome === "rejected"
      ? "text-muted-foreground"
      : row.outcome === "undone"
        ? "text-amber-600 dark:text-amber-400"
        : "text-emerald-600 dark:text-emerald-500"
    : isPending
      ? "text-sky-600 dark:text-sky-400"
      : row.status
        ? STATUS_STYLE[row.status]
        : ""

  return (
    <div
      data-cell-id={row.cellId}
      data-row-index={index}
      onClick={onFocus}
      className={cn(
        "grid gap-x-4 border-b border-l-2 px-3 py-2 text-xs",
        showSource ? "grid-cols-[minmax(64px,7rem)_1fr_1fr]" : "grid-cols-[minmax(64px,6rem)_1fr]",
        focused && !editing && "bg-accent/50",
        rowStripe(row, editing),
      )}
    >
      <div className="flex min-w-0 flex-col items-start gap-1">
        <AppTooltip content={row.ref}>
          <span className="max-w-full truncate font-mono text-[10px] text-muted-foreground">
            {row.ref ?? "·"}
          </span>
        </AppTooltip>
        {stateLabel && <span className={cn("text-[10px] font-medium", stateClass)}>{stateLabel}</span>}
        {row.fileId && onJumpToCell && (
          <AppTooltip content="Open in editor">
            <button
              type="button"
              onClick={() => onJumpToCell(row.fileId!, row.cellId)}
              className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
            >
              <ArrowUpRight className="h-3 w-3" />
              open
            </button>
          </AppTooltip>
        )}
      </div>

      {showSource && (
        <div className="whitespace-pre-wrap break-words text-muted-foreground">{row.source || "∅"}</div>
      )}

      <div className="flex min-w-0 flex-col gap-1.5">
        {isPending ? (
          <>
            {/* The value being replaced. Hidden when empty or identical —
                repeating the new text crossed out reads as noise. */}
            {row.target && row.target !== row.proposed && (
              <span className="whitespace-pre-wrap break-words text-muted-foreground line-through decoration-destructive/40">
                {row.target}
              </span>
            )}

            {editing ? (
              <textarea
                ref={textareaRef}
                dir="auto"
                value={editValue}
                rows={Math.max(2, Math.ceil(editValue.length / 60))}
                onChange={(e) => onEditChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    e.stopPropagation()
                    onAccept?.()
                  } else if (e.key === "Escape") {
                    e.preventDefault()
                    e.stopPropagation()
                    onEditRevert()
                  } else {
                    // Keep j/k/x etc. out of the panel's shortcut handler.
                    e.stopPropagation()
                  }
                }}
                aria-label={`Edit draft for ${row.ref ?? row.cellId}`}
                className="w-full resize-none rounded-md border border-sky-400 bg-background px-2 py-1.5 text-xs leading-relaxed shadow-[0_0_0_3px_rgba(56,189,248,0.12)] outline-none"
              />
            ) : (
              <AppTooltip content="Edit this draft (or just start typing)">
                <button
                  type="button"
                  dir="auto"
                  onClick={onStartEdit}
                  className="whitespace-pre-wrap break-words rounded-sm text-left text-sky-700 hover:bg-sky-500/10 dark:text-sky-300"
                >
                  {editValue}
                </button>
              </AppTooltip>
            )}

            {lint.map((msg) => (
              <span
                key={msg}
                className="inline-flex w-fit items-center gap-1 rounded-md border border-amber-600/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400"
              >
                <AlertTriangle className="h-3 w-3" />
                {msg}
              </span>
            ))}

            {editing ? (
              <span className="text-[10px] text-muted-foreground">
                Enter accept & next · Esc revert to draft · Shift+Enter newline
              </span>
            ) : (
              <span className="flex items-center gap-1 pt-0.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-5 px-1.5 text-[10px]"
                  disabled={busy || !onAccept}
                  onClick={onAccept}
                  aria-label={`Accept draft for ${row.ref ?? row.cellId}`}
                >
                  <Check data-icon="inline-start" />
                  Accept
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[10px] text-muted-foreground"
                  disabled={!onReject}
                  onClick={onReject}
                  aria-label={`Reject draft for ${row.ref ?? row.cellId}`}
                >
                  <X data-icon="inline-start" />
                  Reject
                </Button>
              </span>
            )}
          </>
        ) : row.outcome === "rejected" && !row.target ? (
          <span className="italic text-muted-foreground">draft discarded — cell left untranslated</span>
        ) : (
          <span dir="auto" className="whitespace-pre-wrap break-words">{row.target || "∅"}</span>
        )}
      </div>
    </div>
  )
})
