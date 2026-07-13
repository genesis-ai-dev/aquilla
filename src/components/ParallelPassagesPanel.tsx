// Phase v1.x: ParallelPassagesPanel — project-wide FTS5-backed search dialog.
//
// Replace mode (AQU-177): inline diff preview before applying.
// Scope toggle works: "file" filters client-side on the activeFileId after
// the project-wide fetch; "project" returns all hits.

import { useState, useEffect, useRef, useCallback } from "react"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { AppTooltip } from "@/components/ui/tooltip"
import { SegmentTabs } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import type { WorkspaceSearchResult, SearchOptions } from "@/lib/search/workspace-index"
import { computeReplaceDiffs, type CellReplaceDiff } from "@/lib/search/replace-action"

export type ParallelPanelMode = "search" | "passages" | "replace"
export type ParallelPanelScope = "file" | "project"
export type ParallelPanelSide = "both" | "source" | "target"

/**
 * Called when the user confirms Replace All.
 * Carries the computed diffs so the caller (ProjectWorkspace) can look up
 * parentId/sourceEventId from its `cells` state and emit target.cell.commit
 * events. The panel does not own the commit path — it owns the preview only.
 *
 * SWARM-TODO (ProjectWorkspace.tsx): Add `onReplaceAll` prop to the
 * <ParallelPassagesPanel> call site (around line 2828) and wire it to a
 * `handleReplaceAll` function that:
 *   1. Maps each diff.cellId → cells.find(c => c.id === diff.cellId) to get
 *      the current parentId (c.currentEventId) and sourceEventId (c.sourceEventId).
 *   2. Calls emitTargetCellCommit for each diff with searchQuery=findQuery,
 *      replaceString=replaceQuery.
 *   3. Calls revalidateCells() after all commits are enqueued, then onAfterReplace?.().
 */
export interface ReplaceAllPayload {
  diffs: CellReplaceDiff[]
  totalReplaced: number
  totalSkipped: number
  findQuery: string
  replaceQuery: string
  /**
   * Always false — the "Retain my validations" checkbox was removed (AQU-286).
   * Replacing text advances the cell's chain head; per Q25 (event-anchored
   * validation) prior validations drop automatically and must be re-reviewed.
   * Field kept for backward compat with the ProjectWorkspace call site.
   */
  retainValidations: false
}

interface ParallelPassagesPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: ParallelPanelMode
  scope: ParallelPanelScope
  onScopeChange?: (s: ParallelPanelScope) => void
  onModeChange?: (m: ParallelPanelMode) => void

  activeFileId?: string | null
  activeFileName?: string | null
  activeDoc?: unknown

  loading?: boolean
  ready?: boolean
  results?: WorkspaceSearchResult[]
  onReady?: () => void | Promise<void>
  onSearch?: (query: string, options: SearchOptions) => void
  /** Called when in "passages" mode — routes to searchParallelPassages. */
  onSearchPassages?: (query: string) => void
  onClear?: () => void
  /** Called by ProjectWorkspace to clear results (synonym for onClear). */
  onClearResults?: () => void
  onSelect?: (result: WorkspaceSearchResult, query: string) => void | Promise<void>

  /**
   * AQU-177: Replace mode commit handler. Called when the user clicks
   * "Replace All" or "Replace this cell". The panel has computed the diffs;
   * the caller owns the actual event-emit path.
   *
   * SWARM-TODO: wire this in ProjectWorkspace.tsx ~line 2828.
   */
  onReplaceAll?: (payload: ReplaceAllPayload) => Promise<void> | void

  /** Passed from ProjectWorkspace for role-gating the Replace button. */
  isReadOnly?: boolean

  [extraProp: string]: unknown
}

// ---------------------------------------------------------------------------
// Snippet renderer: preserves <mark> HTML from FTS5 by splitting on tags.
// The server only ever emits <mark>...</mark> — no other tags are injected.
// We walk the string manually so no raw HTML is set on the DOM.
// ---------------------------------------------------------------------------
function Snippet({ html }: { html: string }) {
  const parts = html.split(/(<mark>.*?<\/mark>)/g)
  return (
    <span>
      {parts.map((part, i) => {
        const match = part.match(/^<mark>(.*)<\/mark>$/)
        if (match) {
          return (
            <mark
              key={i}
              className="bg-yellow-200 dark:bg-yellow-800/80 text-inherit rounded-[3px] px-0.5 not-italic"
            >
              {match[1]}
            </mark>
          )
        }
        return <span key={i}>{part}</span>
      })}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Scope / mode tab toggles
// ---------------------------------------------------------------------------

// Inline diff preview row: shows before (strikethrough red) and after (green).
// ---------------------------------------------------------------------------
function DiffPreviewRow({
  diff,
  selected,
  onToggle,
}: {
  diff: CellReplaceDiff
  selected: boolean
  onToggle: (cellId: string) => void
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm transition-colors cursor-pointer",
        "hover:bg-accent/60",
        selected ? "bg-accent/30" : "",
      )}
    >
      <Checkbox
        checked={selected}
        onCheckedChange={() => onToggle(diff.cellId)}
        className="mt-0.5 shrink-0"
        aria-label={`Include cell ${diff.cellId} in replace`}
      />
      <div className="min-w-0 flex-1">
        <div className="text-[10px] text-muted-foreground mb-1 truncate">
          {diff.fileId} · cell {diff.cellId}
        </div>
        <div className="text-xs line-through text-red-600 dark:text-red-400 leading-snug">
          {diff.before}
        </div>
        <div className="text-xs text-green-700 dark:text-green-400 leading-snug">
          {diff.after}
        </div>
        {diff.matchCount > 1 && (
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            {diff.matchCount} replacements in this cell
          </div>
        )}
      </div>
    </label>
  )
}

// ---------------------------------------------------------------------------
// Result row content (search mode — rendered inside CommandItem)
// ---------------------------------------------------------------------------
function SearchResultContent({ result }: { result: WorkspaceSearchResult }) {
  const columnLabel = result.original ? "source" : "target"
  return (
    <>
      <div className="flex w-full items-center justify-between gap-2 mb-1">
        <span className="truncate text-xs font-medium text-muted-foreground leading-none">
          {result.fileName || result.fileId}
        </span>
        <span
          className="shrink-0 text-[9px] font-semibold text-muted-foreground/50 uppercase tracking-widest"
          aria-hidden="true"
        >
          {columnLabel}
        </span>
      </div>
      <div className="w-full text-sm leading-snug">
        <Snippet html={result.snippet || (result.original || result.translated)} />
      </div>
      {result.paired != null && result.paired !== "" && (
        <div className="mt-1.5 w-full pl-2.5 border-l-2 border-muted text-xs text-muted-foreground leading-snug">
          {result.paired}
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Loading skeletons
// ---------------------------------------------------------------------------
function ResultsLoadingSkeleton() {
  return (
    <div role="status" aria-label="Searching…">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="px-3 py-2.5 space-y-2">
          <Skeleton className="h-2.5 w-1/3" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-2/3" />
        </div>
      ))}
      <span className="sr-only">Searching…</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Replace mode section
// ---------------------------------------------------------------------------
interface ReplaceSectionProps {
  query: string
  results: WorkspaceSearchResult[]
  isReadOnly: boolean
  onAfterReplace?: (payload: ReplaceAllPayload) => Promise<void> | void
}

function ReplaceSection({ query, results, isReadOnly, onAfterReplace }: ReplaceSectionProps) {
  const [replaceValue, setReplaceValue] = useState("")
  const [applying, setApplying] = useState(false)
  const [lastResult, setLastResult] = useState<{ replaced: number; skipped: number } | null>(null)

  // Compute diffs from results on every keystroke (pure, cheap).
  const candidates = results
    .filter((r) => !r.original) // target-side only for replace
    .map((r) => ({
      cellId: r.cellId,
      fileId: r.fileId,
      rawValue: r.translated,
      parentId: null, // ProjectWorkspace fills in the real parentId via onReplaceAll
      sourceEventId: null,
    }))

  const { diffs, totalReplaced, totalSkipped } =
    query.trim() && replaceValue !== undefined
      ? computeReplaceDiffs(candidates, query, replaceValue)
      : { diffs: [], totalReplaced: 0, totalSkipped: 0 }

  const [selected, setSelected] = useState<Set<string>>(new Set(diffs.map((d) => d.cellId)))

  // Sync selection when diffs change (new query / replace value).
  useEffect(() => {
    setSelected(new Set(diffs.map((d) => d.cellId)))
  }, [diffs.length, query, replaceValue]) // eslint-disable-line react-hooks/exhaustive-deps

  function toggleCell(cellId: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(cellId)) next.delete(cellId); else next.add(cellId)
      return next
    })
  }

  const selectedDiffs = diffs.filter((d) => selected.has(d.cellId))

  async function handleApply() {
    if (!selectedDiffs.length || applying || isReadOnly) return
    setApplying(true)
    const payload: ReplaceAllPayload = {
      diffs: selectedDiffs,
      totalReplaced,
      totalSkipped,
      findQuery: query,
      replaceQuery: replaceValue,
      retainValidations: false,
    }
    try {
      await onAfterReplace?.(payload)
      setLastResult({ replaced: selectedDiffs.reduce((n, d) => n + d.matchCount, 0), skipped: totalSkipped })
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Replace input */}
      <Input
        placeholder="Replacement text…"
        value={replaceValue}
        onChange={(e) => setReplaceValue(e.target.value)}
        className="h-9 text-sm"
        aria-label="Replacement text"
        disabled={isReadOnly || applying}
      />

      {/* Honest copy: replacing text advances the cell head, dropping prior validations per Q25. */}
      <p className="text-xs text-muted-foreground" role="note">
        Replacing text clears validation — it must be re-reviewed.
      </p>

      {/* Skipped count notice */}
      {totalSkipped > 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400" role="note">
          {totalSkipped} match{totalSkipped !== 1 ? "es" : ""} skipped — spans HTML tag boundary.
        </p>
      )}

      {/* Last apply result toast-like message */}
      {lastResult && (
        <p className="text-xs text-green-700 dark:text-green-400" role="status" aria-live="polite">
          Replaced {lastResult.replaced} cell{lastResult.replaced !== 1 ? "s" : ""}
          {lastResult.skipped > 0 ? ` (${lastResult.skipped} skipped — HTML boundary)` : ""}.
        </p>
      )}

      {/* Diff preview list */}
      {diffs.length > 0 && (
        <>
          <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
            <span>{diffs.length} cell{diffs.length !== 1 ? "s" : ""} affected</span>
            <div className="flex gap-2">
              <button
                type="button"
                className="underline"
                onClick={() => setSelected(new Set(diffs.map((d) => d.cellId)))}
              >
                Select all
              </button>
              <button
                type="button"
                className="underline"
                onClick={() => setSelected(new Set())}
              >
                Select none
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto rounded-lg border border-border bg-background" role="list" aria-label="Cells to replace">
            {diffs.map((diff) => (
              <DiffPreviewRow
                key={diff.cellId}
                diff={diff}
                selected={selected.has(diff.cellId)}
                onToggle={toggleCell}
              />
            ))}
          </div>
        </>
      )}

      {/* Apply button */}
      <AppTooltip
        content={
          isReadOnly
            ? "Replace requires contributor access on these files"
            : !onAfterReplace
              ? "Replace is not yet wired"
              : ""
        }
        className="max-w-xs"
      >
        <span className="inline-flex">
          <button
            type="button"
            disabled={!selectedDiffs.length || applying || isReadOnly || !onAfterReplace}
            onClick={handleApply}
            className={cn(
              "inline-flex h-8 items-center justify-center rounded-lg px-4 text-xs font-medium transition-colors",
              "bg-primary text-primary-foreground hover:bg-primary/90",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
            aria-busy={applying}
          >
            {applying ? "Applying…" : `Replace ${selectedDiffs.length > 0 ? selectedDiffs.length : "All"}`}
          </button>
        </span>
      </AppTooltip>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
const DEBOUNCE_MS = 250

export function ParallelPassagesPanel(props: ParallelPassagesPanelProps) {
  const {
    open,
    onOpenChange,
    mode,
    scope,
    onScopeChange,
    onModeChange,
    activeFileId,
    activeFileName,
    loading = false,
    results = [],
    onSearch,
    onSearchPassages,
    onClear,
    onClearResults,
    onSelect,
    onReplaceAll,
    isReadOnly = false,
    onAfterReplace,
  } = props

  // onAfterReplace is the old name passed by ProjectWorkspace (already in the
  // call site as an extra prop); onReplaceAll is the new typed prop. Prefer
  // the typed one; fall back to the extra-prop version.
  const replaceHandler = (onReplaceAll as ((p: ReplaceAllPayload) => Promise<void> | void) | undefined) ?? (onAfterReplace as ((p: ReplaceAllPayload) => Promise<void> | void) | undefined)

  const clearResults = onClearResults ?? onClear

  const [query, setQuery] = useState("")
  const [side, setSide] = useState<ParallelPanelSide>("both")
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // When replace mode is opened, auto-switch side to "target".
  useEffect(() => {
    if (mode === "replace") {
      setSide("target")
    }
  }, [mode])

  useEffect(() => {
    if (!open) {
      setQuery("")
      clearResults?.()
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const triggerSearch = useCallback(
    (q: string, currentScope: ParallelPanelScope, currentMode: ParallelPanelMode, currentSide: ParallelPanelSide) => {
      if (!q.trim()) {
        clearResults?.()
        return
      }
      if (currentMode === "passages") {
        onSearchPassages?.(q)
        return
      }
      const effectiveSide: ParallelPanelSide = currentMode === "replace" ? "target" : currentSide
      const opts: SearchOptions = {
        scope: currentScope === "file" ? "file" : "project",
        fileId: currentScope === "file" ? (activeFileId ?? undefined) : undefined,
        side: effectiveSide === "both" ? undefined : effectiveSide,
      }
      onSearch?.(q, opts)
    },
    [activeFileId, clearResults, onSearch, onSearchPassages],
  )

  const handleQueryChange = (v: string) => {
    setQuery(v)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      triggerSearch(v, scope, mode, side)
    }, DEBOUNCE_MS)
  }

  const handleScopeChange = (s: ParallelPanelScope) => {
    onScopeChange?.(s)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    triggerSearch(query, s, mode, side)
  }

  const handleModeChange = (m: ParallelPanelMode) => {
    onModeChange?.(m)
    // Re-run the current query under the new mode immediately.
    if (query.trim()) {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      triggerSearch(query, scope, m, side)
    }
  }

  const handleSideChange = (s: ParallelPanelSide) => {
    // In replace mode, side is always "target" — ignore attempts to change.
    if (mode === "replace") return
    setSide(s)
    if (query.trim()) {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      triggerSearch(query, scope, mode, s)
    }
  }

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      triggerSearch(query, scope, mode, side)
    }
  }

  const dialogTitle =
    mode === "passages" ? "Parallel passages" : mode === "replace" ? "Search and Replace" : "Search"

  const scopeLabel =
    scope === "file"
      ? activeFileName
        ? `File: ${activeFileName}`
        : "Current file"
      : "Entire project"

  const isEmpty = !loading && results.length === 0 && query.trim() !== ""
  const isIdle = !loading && results.length === 0 && query.trim() === ""

  const inputPlaceholder =
    mode === "passages"
      ? "Search parallel passages across all projects…"
      : mode === "replace"
      ? `Find in ${scope === "file" ? scopeLabel.toLowerCase() : "project"}…`
      : `Search ${scope === "file" ? scopeLabel.toLowerCase() : "project"}…`

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${dialogTitle} — ${scope === "file" ? scopeLabel : "entire project"}`}
      description={inputPlaceholder}
      showCloseButton
      className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
    >
      <Command
        shouldFilter={false}
        className="flex max-h-[85vh] flex-col gap-0 rounded-none bg-transparent p-0"
      >
        {/* Controls row — pr-10 reserves clearance for the absolute-positioned X close button */}
        <div
          className="flex shrink-0 flex-wrap items-center gap-3 pb-3 pl-4 pr-10 pt-4"
          aria-label="Panel controls"
        >
          <SegmentTabs<ParallelPanelScope>
            value={scope}
            aria-label="Search scope"
            options={[
              { label: "Project", value: "project" },
              {
                label: scope === "file" && activeFileName ? activeFileName : "File",
                value: "file",
                disabled: !activeFileId,
              },
            ]}
            onValueChange={handleScopeChange}
          />
          <SegmentTabs<ParallelPanelMode>
            value={mode}
            aria-label="Search mode"
            options={[
              { label: "Search", value: "search" },
              { label: "Passages", value: "passages" },
              { label: "Replace", value: "replace" },
            ]}
            onValueChange={handleModeChange}
          />
          {mode !== "replace" && (
            <SegmentTabs<ParallelPanelSide>
              value={side}
              aria-label="Content side"
              options={[
                { label: "Both", value: "both" },
                { label: "Source", value: "source" },
                { label: "Target", value: "target" },
              ]}
              onValueChange={handleSideChange}
            />
          )}
        </div>

        <div className="flex shrink-0 flex-col gap-2 px-4 pb-3">
          <CommandInput
            placeholder={inputPlaceholder}
            value={query}
            onValueChange={handleQueryChange}
            onKeyDown={handleSearchKeyDown}
            aria-label={inputPlaceholder}
            aria-busy={loading}
          />
          {scope === "file" && !activeFileId && (
            <p className="text-xs text-muted-foreground" role="note">
              Open a file to enable file-scoped search.
            </p>
          )}

          {mode === "replace" && (
            <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/20 px-3 py-3">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Replace (target cells only)
              </div>
              <ReplaceSection
                query={query}
                results={results}
                isReadOnly={isReadOnly as boolean}
                onAfterReplace={replaceHandler}
              />
            </div>
          )}
        </div>

        <CommandList className="max-h-none min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-border px-2 py-2">
          {loading && <ResultsLoadingSkeleton />}

          {!loading && isIdle && (
            <CommandEmpty aria-live="polite">
              {mode === "passages"
                ? "Type to find parallel passages — results show source and target side by side."
                : mode === "replace"
                ? "Type a search term above to find target cells for replacement."
                : `Type to search across ${scope === "file" ? "the open file" : "the project"}.`}
            </CommandEmpty>
          )}

          {!loading && isEmpty && (
            <CommandEmpty aria-live="polite">
              No results for{" "}
              <span className="font-medium text-foreground">&ldquo;{query}&rdquo;</span>.
            </CommandEmpty>
          )}

          {!loading && results.length > 0 && (
            <CommandGroup>
              {results.map((r) => {
                const columnLabel = r.original ? "source" : "target"
                const itemKey = `${r.fileId}:${r.cellId}:${r.original ? "src" : "tgt"}`
                return (
                  <CommandItem
                    key={itemKey}
                    value={itemKey}
                    aria-label={`${r.fileName || r.fileId} — ${columnLabel}`}
                    className="flex flex-col items-start rounded-xl px-3 py-2.5"
                    onSelect={() => onSelect?.(r, query)}
                  >
                    <SearchResultContent result={r} />
                  </CommandItem>
                )
              })}
            </CommandGroup>
          )}
        </CommandList>

        {!loading && results.length > 0 && (
          <div className="flex shrink-0 items-center justify-between border-t border-border bg-muted/20 px-4 py-2.5">
            <span className="text-xs tabular-nums text-muted-foreground">
              {results.length.toLocaleString()} result{results.length !== 1 ? "s" : ""}
            </span>
            <span className="max-w-[60%] truncate text-right text-xs text-muted-foreground">
              {mode === "passages" ? "Parallel passages" : scopeLabel}
            </span>
          </div>
        )}
      </Command>
    </CommandDialog>
  )
}
