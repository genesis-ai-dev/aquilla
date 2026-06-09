// Phase v1.x: ParallelPassagesPanel — project-wide FTS5-backed search dialog.
//
// Replace mode is OUT OF SCOPE (bulk-write path is a separate feature).
// Scope toggle works: "file" filters client-side on the activeFileId after
// the project-wide fetch; "project" returns all hits.

import { useState, useEffect, useRef, useCallback } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import type { WorkspaceSearchResult, SearchOptions } from "@/lib/search/workspace-index"

export type ParallelPanelMode = "search" | "passages" | "replace"
export type ParallelPanelScope = "file" | "project"
export type ParallelPanelSide = "both" | "source" | "target"

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
// Scope / mode pill toggles
// ---------------------------------------------------------------------------
function PillToggle<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  value: T
  options: { label: string; value: T; disabled?: boolean }[]
  onChange: (v: T) => void
  disabled?: boolean
  label: string
}) {
  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-full bg-muted/50 p-0.5"
      role="group"
      aria-label={label}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          disabled={disabled || opt.disabled}
          onClick={() => onChange(opt.value)}
          aria-pressed={value === opt.value}
          title={opt.disabled ? "Coming soon" : undefined}
          className={cn(
            "inline-flex h-6 items-center rounded-full px-2.5 text-[11px] font-medium tracking-tight transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
            "disabled:cursor-not-allowed disabled:opacity-40",
            value === opt.value
              ? "bg-background text-foreground shadow-sm ring-1 ring-foreground/8"
              : "text-muted-foreground hover:text-foreground hover:bg-background/50",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Result row
// ---------------------------------------------------------------------------
function ResultRow({
  result,
  query,
  onSelect,
}: {
  result: WorkspaceSearchResult
  query: string
  onSelect: (result: WorkspaceSearchResult, query: string) => void
}) {
  const columnLabel = result.original ? "source" : "target"
  return (
    <button
      type="button"
      onClick={() => onSelect(result, query)}
      aria-label={`${result.fileName || result.fileId} — ${columnLabel}`}
      className={cn(
        "w-full text-left rounded-xl px-3 py-2.5 text-sm transition-colors",
        "hover:bg-accent/60 hover:text-accent-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        "active:bg-accent",
      )}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
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
      <div className="text-sm leading-snug">
        <Snippet html={result.snippet || (result.original || result.translated)} />
      </div>
      {result.paired != null && result.paired !== "" && (
        <div className="mt-1.5 pl-2.5 border-l-2 border-muted text-xs text-muted-foreground leading-snug">
          {result.paired}
        </div>
      )}
    </button>
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
  } = props

  const clearResults = onClearResults ?? onClear

  const [query, setQuery] = useState("")
  const [side, setSide] = useState<ParallelPanelSide>("both")
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Focus the input when the dialog opens.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 50)
      return () => clearTimeout(t)
    } else {
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
      const opts: SearchOptions = {
        scope: currentScope === "file" ? "file" : "project",
        fileId: currentScope === "file" ? (activeFileId ?? undefined) : undefined,
        side: currentSide === "both" ? undefined : currentSide,
      }
      onSearch?.(q, opts)
    },
    [activeFileId, clearResults, onSearch, onSearchPassages],
  )

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
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
    setSide(s)
    if (query.trim()) {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      triggerSearch(query, scope, mode, s)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      triggerSearch(query, scope, mode, side)
    }
  }

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
      : `Search ${scope === "file" ? scopeLabel.toLowerCase() : "project"}…`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex flex-col gap-0 p-0 sm:max-w-2xl max-h-[85vh] overflow-hidden">
        {/* Visually-hidden title for screen readers */}
        <DialogHeader className="sr-only">
          <DialogTitle>
            {mode === "passages" ? "Parallel passages" : "Search"} —{" "}
            {scope === "file" ? scopeLabel : "entire project"}
          </DialogTitle>
        </DialogHeader>

        {/* Controls row — pr-10 reserves clearance for the absolute-positioned X close button (size-7 at right-2) */}
        <div
          className="flex flex-wrap items-center gap-3 pl-4 pr-10 pt-4 pb-3 shrink-0"
          aria-label="Panel controls"
        >
          <PillToggle<ParallelPanelScope>
            value={scope}
            label="Search scope"
            options={[
              { label: "Project", value: "project" },
              {
                label: scope === "file" && activeFileName ? activeFileName : "File",
                value: "file",
                disabled: !activeFileId,
              },
            ]}
            onChange={handleScopeChange}
          />
          <PillToggle<ParallelPanelMode>
            value={mode}
            label="Search mode"
            options={[
              { label: "Search", value: "search" },
              { label: "Passages", value: "passages" },
              { label: "Replace", value: "replace", disabled: true },
            ]}
            onChange={handleModeChange}
          />
          <PillToggle<ParallelPanelSide>
            value={side}
            label="Content side"
            options={[
              { label: "Both", value: "both" },
              { label: "Source", value: "source" },
              { label: "Target", value: "target" },
            ]}
            onChange={handleSideChange}
          />
        </div>

        {/* Search input */}
        <div className="px-4 pb-3 shrink-0">
          <Input
            ref={inputRef}
            placeholder={inputPlaceholder}
            value={query}
            onChange={handleQueryChange}
            onKeyDown={handleKeyDown}
            className="h-9 text-sm"
            aria-label={inputPlaceholder}
            aria-busy={loading}
          />
          {scope === "file" && !activeFileId && (
            <p className="mt-1.5 text-xs text-muted-foreground" role="note">
              Open a file to enable file-scoped search.
            </p>
          )}
          {mode === "replace" && (
            <div
              className="mt-2 rounded-xl border border-dashed border-muted-foreground/25 bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground"
              role="note"
            >
              Bulk replace is coming soon — search works now.
            </div>
          )}
        </div>

        {/* Results */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-border">
          <div className="px-2 py-2 space-y-0.5">
            {loading && <ResultsLoadingSkeleton />}

            {!loading && isIdle && (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground select-none" aria-live="polite">
                {mode === "passages"
                  ? "Type to find parallel passages — results show source and target side by side."
                  : `Type to search across ${scope === "file" ? "the open file" : "the project"}.`}
              </p>
            )}

            {!loading && isEmpty && (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground select-none" aria-live="polite">
                No results for{" "}
                <span className="font-medium text-foreground">&ldquo;{query}&rdquo;</span>.
              </p>
            )}

            {!loading &&
              results.map((r) => (
                <ResultRow
                  key={`${r.fileId}:${r.cellId}:${r.original ? "src" : "tgt"}`}
                  result={r}
                  query={query}
                  onSelect={(result, q) => onSelect?.(result, q)}
                />
              ))}
          </div>
        </div>

        {/* Footer — only when there are results */}
        {!loading && results.length > 0 && (
          <div className="px-4 py-2.5 shrink-0 border-t border-border flex items-center justify-between bg-muted/20">
            <span className="text-xs text-muted-foreground tabular-nums">
              {results.length.toLocaleString()} result{results.length !== 1 ? "s" : ""}
            </span>
            <span className="text-xs text-muted-foreground truncate max-w-[60%] text-right">
              {mode === "passages" ? "Parallel passages" : scopeLabel}
            </span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
