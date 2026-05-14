import { useState } from "react"
import { X, User, Bot, Check, BookOpen, ChevronDown, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { CellData } from "@/hooks/useCells"
import type { CellHistoryEntry } from "@/lib/parsers/types"
import { cn } from "@/lib/utils"
import { useCellEditHistory } from "@/hooks/useCellEditHistory"

interface HistoryDrawerProps {
  cell: CellData
  onClose: () => void
  /** Project the cell belongs to — required (Phase 2b) for the
   *  project-scoped history endpoint on the sync-worker. Phase 2a's
   *  /events route was file-scoped; Phase 2b's per-cell history route is
   *  project-scoped so we surface projectId explicitly here. */
  projectId?: string | null
  /** File the cell belongs to — required to fetch D1 audit history. */
  fileId?: string | null
  /** Fetches a file-scoped sync token (same as Phase 2 outbox flusher). */
  getTokenForFile?: (fileId: string) => Promise<string | null>
}

interface EntryGroup {
  // All entries in chronological order within this group.
  entries: CellHistoryEntry[]
  // The terminal entry of the group — what the drawer shows by default.
  // For human incremental edits this is the last state typed; for llm
  // completions there's usually just one entry per group.
  terminal: CellHistoryEntry
  // Original index in the full history array (for stable keys).
  startIndex: number
}

/**
 * Group consecutive history entries that appear to be part of the same "edit
 * session" (same author, same source, close in time, with each text being a
 * small incremental change of the last). Show only the terminal state of each
 * group by default — this collapses runs of keystroke-level entries (eg. the
 * 244-revision case) into a single summary card with an expand toggle.
 */
function groupHistory(history: CellHistoryEntry[]): EntryGroup[] {
  const groups: EntryGroup[] = []
  for (let i = 0; i < history.length; i++) {
    const entry = history[i]
    const last = groups[groups.length - 1]
    if (last && isSameEditSession(last.entries[last.entries.length - 1], entry)) {
      last.entries.push(entry)
      last.terminal = entry
    } else {
      groups.push({ entries: [entry], terminal: entry, startIndex: i })
    }
  }
  return groups
}

function isSameEditSession(a: CellHistoryEntry, b: CellHistoryEntry): boolean {
  if (a.author !== b.author) return false
  if (a.source !== b.source) return false
  // LLM entries never merge — each completion is meaningful on its own.
  if (a.source === "llm" || b.source === "llm") return false
  // Validation flips (unvalidated → validated) should stay distinct.
  if (a.validated !== b.validated) return false
  // Within 2 minutes
  const aTime = new Date(a.timestamp).getTime()
  const bTime = new Date(b.timestamp).getTime()
  if (Math.abs(bTime - aTime) > 2 * 60 * 1000) return false
  // Must be an incremental edit: one string is a prefix of or differs by <= 3
  // characters from the other. Handles typing, backspacing, and minor edits.
  return isIncrementalEdit(a.value, b.value)
}

function isIncrementalEdit(prev: string, next: string): boolean {
  if (prev === next) return true
  if (prev.length === 0 || next.length === 0) return true
  // Prefix relationship (typical for typing / backspacing)
  if (prev.startsWith(next) || next.startsWith(prev)) return true
  // Small character-level distance — quick cheap check (not full Levenshtein)
  const diff = Math.abs(prev.length - next.length)
  if (diff > 8) return false
  // Check how many characters at the end differ
  const commonPrefix = commonPrefixLength(prev, next)
  const commonSuffix = commonSuffixLength(prev, next, commonPrefix)
  const changedPrev = prev.length - commonPrefix - commonSuffix
  const changedNext = next.length - commonPrefix - commonSuffix
  return Math.max(changedPrev, changedNext) <= 8
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0
  const max = Math.min(a.length, b.length)
  while (i < max && a[i] === b[i]) i++
  return i
}

function commonSuffixLength(a: string, b: string, prefixLen: number): number {
  let i = 0
  while (
    i < a.length - prefixLen &&
    i < b.length - prefixLen &&
    a[a.length - 1 - i] === b[b.length - 1 - i]
  ) i++
  return i
}

export function HistoryDrawer({ cell, onClose, projectId, fileId, getTokenForFile }: HistoryDrawerProps) {
  const enabled = !!projectId && !!fileId && !!getTokenForFile
  const {
    history: d1History,
    isLoading: d1Loading,
    isError: d1Error,
  } = useCellEditHistory({
    enabled,
    projectId: projectId ?? null,
    fileId: fileId ?? null,
    cellId: cell.id,
    getTokenForFile: getTokenForFile ?? (() => Promise.resolve(null)),
  })

  // Prefer D1 history when available; fall back to Y.Doc history when D1 is
  // loading, errored, or returned no entries (cell may not have D1 records yet).
  const history = enabled && !d1Loading && !d1Error && d1History.length > 0
    ? d1History
    : cell.history || []

  const groups = groupHistory(history).slice().reverse() // most recent group first
  const hiddenCount = history.length - groups.length

  function formatTimestamp(iso: string): string {
    try {
      return new Date(iso).toLocaleString()
    } catch {
      return iso
    }
  }

  return (
    <div className="flex h-full w-96 flex-col border-l bg-background">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h3 className="text-sm font-semibold">
          Edit history {cell.context && <span className="text-muted-foreground">· {cell.context}</span>}
        </h3>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="border-b px-3 py-2 text-xs">
        <div className="text-muted-foreground">Source</div>
        <div className="mt-0.5">{cell.original}</div>
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-2">
        {history.length === 0 ? (
          <p className="text-xs text-muted-foreground">No edits yet.</p>
        ) : (
          <>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {groups.length} significant {groups.length === 1 ? "revision" : "revisions"}
              {hiddenCount > 0 && (
                <span className="ml-1 normal-case text-muted-foreground/70">
                  ({history.length} total, {hiddenCount} minor intermediate edits collapsed)
                </span>
              )}
            </p>
            <ol className="space-y-2">
              {groups.map((group, i) => (
                <GroupItem
                  key={`${group.terminal.timestamp}-${group.startIndex}`}
                  group={group}
                  isCurrent={i === 0}
                  formatTimestamp={formatTimestamp}
                />
              ))}
            </ol>
          </>
        )}
      </div>
    </div>
  )
}

function GroupItem({
  group,
  isCurrent,
  formatTimestamp,
}: {
  group: EntryGroup
  isCurrent: boolean
  formatTimestamp: (iso: string) => string
}) {
  const [expanded, setExpanded] = useState(false)
  const terminal = group.terminal
  const Icon = terminal.source === "llm" ? Bot : User
  const sourceColor =
    terminal.source === "llm"
      ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400"
      : "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400"
  const validatedColor = terminal.validated
    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
    : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400"
  const hasSubEntries = group.entries.length > 1

  return (
    <li
      className={cn(
        "rounded border p-2 text-sm",
        isCurrent && "border-primary/40 bg-primary/5"
      )}
    >
      <div className="mb-1 flex flex-wrap items-center gap-1 text-xs">
        <span className={cn("flex items-center gap-0.5 rounded px-1.5 py-0.5 font-medium", sourceColor)}>
          <Icon className="h-3 w-3" />
          {terminal.source}
        </span>
        <span className={cn("flex items-center gap-0.5 rounded px-1.5 py-0.5 font-medium", validatedColor)}>
          {terminal.validated ? <Check className="h-3 w-3" /> : null}
          {terminal.validated ? "validated" : "unvalidated"}
        </span>
        {hasSubEntries && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            +{group.entries.length - 1} minor edit{group.entries.length - 1 !== 1 ? "s" : ""}
          </span>
        )}
        <span className="ml-auto text-muted-foreground">
          {formatTimestamp(terminal.timestamp)}
        </span>
      </div>
      <div className="text-xs text-muted-foreground">
        by <span className="font-medium">{terminal.author}</span>
        {isCurrent && <span className="ml-1.5 text-primary">· current</span>}
      </div>
      <div className="mt-1 whitespace-pre-wrap rounded bg-muted/40 p-2 text-xs">
        {terminal.value || <span className="italic text-muted-foreground">(empty)</span>}
      </div>
      {terminal.examples && terminal.examples.length > 0 && (
        <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
          <BookOpen className="h-3 w-3" />
          {terminal.examples.length} example{terminal.examples.length !== 1 ? "s" : ""} used
        </div>
      )}
      {hasSubEntries && (
        <>
          <button
            onClick={() => setExpanded(!expanded)}
            className="mt-2 flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {expanded ? "Hide" : "Show"} intermediate edits
          </button>
          {expanded && (
            <ol className="mt-1 space-y-1 border-l-2 pl-2">
              {group.entries.slice(0, -1).map((entry, j) => (
                <li
                  key={`${entry.timestamp}-${j}`}
                  className="rounded bg-muted/20 p-1 text-[10px]"
                >
                  <div className="text-muted-foreground">{formatTimestamp(entry.timestamp)}</div>
                  <div className="mt-0.5 whitespace-pre-wrap">
                    {entry.value || <span className="italic text-muted-foreground">(empty)</span>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </li>
  )
}
