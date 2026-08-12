import { useEffect, useRef, useState } from "react"
import { X, User, Bot, Check, BookOpen, ChevronDown, ChevronRight, GitBranch, CloudOff } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import type { CellData } from "@/hooks/useCells"
import type { CellHistoryEntry } from "@/lib/parsers/types"
import { cn } from "@/lib/utils"
import { useCellEditHistory } from "@/hooks/useCellEditHistory"
import { FootnotedTextValue } from "./footnotes/FootnoteInline"
import { RightSidebarPanel } from "./RightSidebarPanel"
import { useT } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"

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
  /** Whether this project has cloud (D1) history at all. Gates the
   *  fetch-error state: tokenless local projects legitimately fall back to
   *  cell.history and must not see a scary "couldn't load" message. */
  isSynced?: boolean
  /** Called when the user confirms promoting a stale-branch entry to current.
   *  AD-2: the caller should emit a new target-cell commit whose parentId is
   *  the current chain head, making the promoted text the new current value. */
  onPromote?: (entry: CellHistoryEntry) => void
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
  // Stale-branch commits never merge into a chain-winning group (or vice
  // versa). A "session" collapses keystroke-level edits that ended in one
  // committed value — mixing a bumped branch into that obscures both.
  if ((a.isStale ?? false) !== (b.isStale ?? false)) return false
  if (a.syncState !== b.syncState) return false
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

export function HistoryDrawer({ cell, onClose, projectId, fileId, getTokenForFile, isSynced = false, onPromote }: HistoryDrawerProps) {
  const t = useT()
  const enabled = !!projectId && !!fileId && !!getTokenForFile
  // Target side is the typical edit surface in this translation app, so we
  // use `targetEventId` as the AD-2 chain head when computing stale-branch
  // markers. If the user is viewing source-side history the head won't be
  // in the returned events list and `computeOnChainSet` falls back to
  // "everything is current" (safer than mis-flagging).
  const currentEventId = cell.targetEventId || null
  const {
    history: d1History,
    isLoading: d1Loading,
    isError: d1Error,
    revalidate,
  } = useCellEditHistory({
    enabled,
    projectId: projectId ?? null,
    fileId: fileId ?? null,
    cellId: cell.id,
    getTokenForFile: getTokenForFile ?? (() => Promise.resolve(null)),
    currentEventId,
  })

  // Prefer server + locally durable outbox history whenever either has an
  // entry. Fall back only for legacy cells without event-log history.
  const history = enabled && d1History.length > 0
    ? d1History
    : cell.history || []

  const groups = groupHistory(history).slice().reverse() // most recent group first
  const hiddenCount = history.length - groups.length
  // "Current" is the first ON-CHAIN group when reading newest-first. A
  // stale-branch group can be more recent by wall-clock than the chain
  // head (offline-reconnect scenario) — calling that the current value
  // would be a lie. Falls back to the first group if no on-chain group
  // exists (legacy entries without an `isStale` flag).
  const currentGroupIndex = groups.findIndex((g) => (
    !(g.terminal.isStale ?? false) && g.terminal.syncState !== "failed"
  ))
  const hasAnyStale = groups.some((g) => g.terminal.isStale ?? false)
  const firstStaleGroupRef = useRef<HTMLLIElement | null>(null)
  // When the drawer opens with a stale-branch commit present (typical
  // entry path: user clicked "View in history" from the F6 banner) the
  // user's attention should land on the bumped edit, not the unchanged
  // chain head at the top.
  useEffect(() => {
    if (!hasAnyStale) return
    firstStaleGroupRef.current?.scrollIntoView({ block: "nearest" })
  }, [hasAnyStale])

  function formatTimestamp(iso: string): string {
    try {
      return new Date(iso).toLocaleString()
    } catch {
      return iso
    }
  }

  return (
    <RightSidebarPanel storageKey="history" defaultWidth={384} resizeLabel="Resize history panel">
    <div className="flex h-full w-full flex-col border-l bg-card">
      <div className="flex items-center justify-between border-b p-2">
        <h3 className="text-sm font-semibold">
          {t("editor.history.title")} {cell.context && <span className="text-muted-foreground">· {cell.context}</span>}
        </h3>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t("editor.history.close")}>
          <X />
        </Button>
      </div>

      <div className="border-b px-3 py-2 text-xs">
        <div className="text-muted-foreground">{t("editor.column.source")}</div>
        <div className="mt-0.5">{cell.original}</div>
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-2">
        {isSynced && d1Loading && history.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("editor.history.loading")}</p>
        ) : isSynced && d1Error && history.length === 0 ? (
          // A failed D1 fetch on a synced project used to fall through to
          // "No edits yet." — confidently wrong for cells with real history.
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">{t("editor.history.loadFailed")}</p>
            <button
              type="button"
              onClick={revalidate}
              className="text-[11px] font-medium text-primary hover:text-primary/80 underline underline-offset-2"
            >
              {t("common.retry")}
            </button>
          </div>
        ) : history.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("editor.history.noEdits")}</p>
        ) : (
          <>
            {isSynced && d1Error && (
              <p className="text-[10px] text-muted-foreground">
                {t("editor.history.refreshFailed")}{" "}
                <button
                  type="button"
                  onClick={revalidate}
                  className="font-medium text-primary hover:text-primary/80 underline underline-offset-2"
                >
                  {t("common.retry")}
                </button>
              </p>
            )}
            <p className="text-[10px] text-muted-foreground">
              {t("editor.history.revisions", { count: groups.length })}
              {hiddenCount > 0 && (
                <span className="ml-1 normal-case text-muted-foreground/70">
                  {t("editor.history.collapsedNote", {
                    total: history.length,
                    hidden: hiddenCount,
                  })}
                </span>
              )}
            </p>
            <ol className="space-y-2">
              {groups.map((group, i) => {
                const isStale = group.terminal.isStale ?? false
                // First stale group in render order gets the ref so the
                // open-drawer-from-banner flow can scroll it into view.
                const isFirstStale =
                  isStale && groups.findIndex((g) => g.terminal.isStale ?? false) === i
                return (
                  <GroupItem
                    key={`${group.terminal.timestamp}-${group.startIndex}`}
                    group={group}
                    isCurrent={i === currentGroupIndex}
                    formatTimestamp={formatTimestamp}
                    refForFirstStale={isFirstStale ? firstStaleGroupRef : null}
                    onPromote={onPromote}
                  />
                )
              })}
            </ol>
          </>
        )}
      </div>
    </div>
    </RightSidebarPanel>
  )
}

function GroupItem({
  group,
  isCurrent,
  formatTimestamp,
  refForFirstStale,
  onPromote,
}: {
  group: EntryGroup
  isCurrent: boolean
  formatTimestamp: (iso: string) => string
  /** Ref attached to the first stale-branch group in the list, used by
   *  HistoryDrawer to scroll the user's attention to it when the drawer
   *  opens via the F6 banner. */
  refForFirstStale: React.RefObject<HTMLLIElement | null> | null
  onPromote?: (entry: CellHistoryEntry) => void
}) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const [pendingPromote, setPendingPromote] = useState(false)
  const terminal = group.terminal
  const isStale = terminal.isStale ?? false
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
      ref={refForFirstStale ?? undefined}
      className={cn(
        "rounded border p-2 text-sm",
        isCurrent && "border-primary/40 bg-primary/5",
        // Stale-branch styling: dashed border + muted background so the
        // user can scan and immediately see which entries are "your bumped
        // edits" vs the chain lineage. We deliberately don't strike through
        // the value — the text is still real edits the user might want to
        // promote.
        isStale && "border-dashed border-amber-300/70 bg-amber-50/40 dark:border-amber-700/60 dark:bg-amber-950/20",
      )}
    >
      <div className="mb-1 flex flex-wrap items-center gap-1 text-xs">
        <span className={cn("flex items-center gap-0.5 rounded px-1.5 py-0.5 font-medium", sourceColor)}>
          <Icon className="h-3 w-3" />
          {terminal.source}
        </span>
        <span className={cn("flex items-center gap-0.5 rounded px-1.5 py-0.5 font-medium", validatedColor)}>
          {terminal.validated ? <Check className="h-3 w-3" /> : null}
          {terminal.validated ? t("editor.state.validated") : t("editor.state.unvalidated")}
        </span>
        {isStale && (
          <AppTooltip
            content={t("editor.history.staleTooltip")}
            className="max-w-xs"
          >
            <span className="flex items-center gap-0.5 rounded bg-amber-200/60 px-1.5 py-0.5 font-medium text-amber-900 dark:bg-amber-800/50 dark:text-amber-200">
              <GitBranch className="h-3 w-3" />
              {t("editor.history.staleBadge")}
            </span>
          </AppTooltip>
        )}
        {terminal.syncState === "pending" && (
          <span className="flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">
            <Spinner className="size-3" />
            {t("editor.history.syncing")}
          </span>
        )}
        {terminal.syncState === "failed" && (
          <AppTooltip content={t("editor.history.syncFailedTooltip")}>
            <span className="flex items-center gap-0.5 rounded bg-destructive/10 px-1.5 py-0.5 font-medium text-destructive">
              <CloudOff className="h-3 w-3" />
              {t("editor.history.syncFailed")}
            </span>
          </AppTooltip>
        )}
        {hasSubEntries && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {t("editor.history.minorEdits", { count: group.entries.length - 1 })}
          </span>
        )}
        <span className="ml-auto text-muted-foreground">
          {formatTimestamp(terminal.timestamp)}
        </span>
      </div>
      <div className="text-xs text-muted-foreground">
        {/* The name is the one scannable word in a line of muted metadata, so it
            keeps its weight inside the translated attribution. */}
        <RichMessage
          k="editor.history.author"
          values={{ author: <span className="font-medium">{terminal.author}</span> }}
        />
        {isCurrent && <span className="ml-1.5 text-primary">{t("editor.history.currentMarker")}</span>}
        {isStale && (
          <span className="ml-1.5 text-amber-700 dark:text-amber-300">
            {t("editor.history.bumpedMarker")}
          </span>
        )}
      </div>
      <div className="mt-1 rounded bg-muted/40 p-2 text-xs">
        <FootnotedTextValue value={terminal.value} showFootnotes />
      </div>
      {terminal.examples && terminal.examples.length > 0 && (
        <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
          <BookOpen className="h-3 w-3" />
          {t("editor.history.examples", { count: terminal.examples.length })}
        </div>
      )}
      {isStale && onPromote && !pendingPromote && (
        <button
          onClick={() => setPendingPromote(true)}
          className="mt-2 text-[11px] font-medium text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100 underline underline-offset-2"
        >
          {t("editor.history.promote")}
        </button>
      )}
      {isStale && onPromote && pendingPromote && (
        <div className="mt-2 flex items-center gap-2 text-[11px]">
          <span className="text-muted-foreground">{t("editor.history.promoteConfirm")}</span>
          <button
            onClick={() => { onPromote(terminal); setPendingPromote(false) }}
            className="font-medium text-primary hover:text-primary/80"
          >
            {t("common.confirm")}
          </button>
          <button
            onClick={() => setPendingPromote(false)}
            className="text-muted-foreground hover:text-foreground"
          >
            {t("common.cancel")}
          </button>
        </div>
      )}
      {hasSubEntries && (
        <>
          <button
            onClick={() => setExpanded(!expanded)}
            className="mt-2 flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {expanded ? t("editor.history.hideIntermediate") : t("editor.history.showIntermediate")}
          </button>
          {expanded && (
            <ol className="mt-1 space-y-1 border-l-2 pl-2">
              {group.entries.slice(0, -1).map((entry, j) => (
                <li
                  key={`${entry.timestamp}-${j}`}
                  className="rounded bg-muted/20 p-1 text-[10px]"
                >
                  <div className="text-muted-foreground">{formatTimestamp(entry.timestamp)}</div>
                  <div className="mt-0.5">
                    <FootnotedTextValue value={entry.value} showFootnotes />
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
