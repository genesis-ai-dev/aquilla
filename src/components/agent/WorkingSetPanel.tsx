/**
 * WorkingSetPanel.tsx — the workbench's right pane: the cells the agent is
 * touching, as aligned source/target rows that fill in live from tool
 * results, with staged drafts shown as pending diffs the user accepts or
 * rejects per row (or all at once). Keyboard-first: j/k move, a accept,
 * x reject, Shift+A accept all.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { ArrowUpRight, Check, ListChecks, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { pendingRows, type WorkingSetRow } from "@/lib/agent/working-set"

const STATUS_STYLE: Record<string, string> = {
  untranslated: "text-muted-foreground",
  drafted: "text-sky-600 dark:text-sky-400",
  stale: "text-amber-600 dark:text-amber-400",
  validated: "text-emerald-600 dark:text-emerald-500",
  flagged: "text-destructive",
}

export interface WorkingSetPanelProps {
  rows: WorkingSetRow[]
  /** Apply one staged row (undefined while a role can't apply). */
  onAccept?: (row: WorkingSetRow) => void | Promise<void>
  onReject?: (row: WorkingSetRow) => void
  onAcceptAll?: () => void | Promise<void>
  /** Jump the editor to a cell. */
  onJumpToCell?: (fileId: string, cellId: string) => void
  /** Disables the apply buttons while an apply is in flight. */
  busy?: boolean
}

export function WorkingSetPanel({ rows, onAccept, onReject, onAcceptAll, onJumpToCell, busy }: WorkingSetPanelProps) {
  const pending = useMemo(() => pendingRows(rows), [rows])
  const [focusIdx, setFocusIdx] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  // Keep focus index in range as rows change.
  useEffect(() => {
    setFocusIdx((i) => Math.min(i, Math.max(rows.length - 1, 0)))
  }, [rows.length])

  const focused = rows[focusIdx]

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "j" || e.key === "ArrowDown") {
      e.preventDefault()
      setFocusIdx((i) => Math.min(i + 1, rows.length - 1))
    } else if (e.key === "k" || e.key === "ArrowUp") {
      e.preventDefault()
      setFocusIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === "a" && focused?.proposed !== undefined && onAccept && !busy) {
      e.preventDefault()
      void onAccept(focused)
    } else if (e.key === "x" && focused?.proposed !== undefined && onReject) {
      e.preventDefault()
      onReject(focused)
    } else if (e.key === "A" && e.shiftKey && pending.length > 0 && onAcceptAll && !busy) {
      e.preventDefault()
      void onAcceptAll()
    }
  }

  if (rows.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center text-muted-foreground">
        <ListChecks className="h-5 w-5" />
        <p className="text-xs">
          The cells the agent reads and drafts appear here — source on the left, translation on the
          right, with staged drafts to accept or reject.
        </p>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      aria-label="Working set"
      className="flex h-full min-h-0 flex-col outline-none"
    >
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <span className="text-xs font-medium">Working set</span>
        <span className="text-[11px] text-muted-foreground">
          {rows.length} cell{rows.length === 1 ? "" : "s"}
          {pending.length > 0 && ` · ${pending.length} pending`}
        </span>
        {pending.length > 0 && onAcceptAll && (
          <Button
            type="button"
            size="sm"
            className="ml-auto h-6 text-[11px]"
            disabled={busy}
            onClick={() => void onAcceptAll()}
            title="Accept every pending draft (Shift+A)"
          >
            <Check data-icon="inline-start" />
            Accept all ({pending.length})
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.map((row, idx) => {
          const isPending = row.proposed !== undefined && row.stagedEvent
          const isFocused = idx === focusIdx
          return (
            <div
              key={row.cellId}
              data-cell-id={row.cellId}
              onClick={() => setFocusIdx(idx)}
              className={cn(
                "grid grid-cols-[minmax(52px,auto)_1fr_1fr] gap-x-3 border-b px-3 py-2 text-xs",
                isFocused && "bg-accent/50",
                isPending && "bg-sky-500/5",
              )}
            >
              <div className="flex flex-col items-start gap-1">
                <span className="font-mono text-[10px] text-muted-foreground">{row.ref ?? "·"}</span>
                {row.status && (
                  <span className={cn("text-[10px]", STATUS_STYLE[row.status])}>{row.status}</span>
                )}
                {row.fileId && onJumpToCell && (
                  <button
                    type="button"
                    onClick={() => onJumpToCell(row.fileId!, row.cellId)}
                    className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                    title="Open in editor"
                  >
                    <ArrowUpRight className="h-3 w-3" />
                    open
                  </button>
                )}
              </div>

              <div className="whitespace-pre-wrap break-words text-muted-foreground">{row.source || "∅"}</div>

              <div className="flex min-w-0 flex-col gap-1">
                {isPending ? (
                  <>
                    {/* Strikethrough = the value being replaced. Skip it when
                        the cell is empty or already equals the proposal —
                        repeating the new text crossed out reads as noise. */}
                    {row.target && row.target !== row.proposed && (
                      <span className="whitespace-pre-wrap break-words text-muted-foreground line-through decoration-destructive/40">
                        {row.target}
                      </span>
                    )}
                    <span className="whitespace-pre-wrap break-words text-sky-700 dark:text-sky-300">
                      {row.proposed}
                    </span>
                    <span className="flex items-center gap-1 pt-0.5">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-5 px-1.5 text-[10px]"
                        disabled={busy || !onAccept}
                        onClick={() => onAccept && void onAccept(row)}
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
                        onClick={() => onReject?.(row)}
                        aria-label={`Reject draft for ${row.ref ?? row.cellId}`}
                      >
                        <X data-icon="inline-start" />
                        Reject
                      </Button>
                    </span>
                  </>
                ) : (
                  <span className="whitespace-pre-wrap break-words">{row.target || "∅"}</span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="border-t px-3 py-1 text-[10px] text-muted-foreground">
        j/k move · a accept · x reject · Shift+A accept all
      </div>
    </div>
  )
}
