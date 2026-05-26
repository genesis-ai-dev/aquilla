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
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import type { WorkspaceSearchResult, SearchOptions } from "@/lib/search/workspace-index"

export type ParallelPanelMode = "search" | "replace"
export type ParallelPanelScope = "file" | "project"

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
              className="bg-yellow-200 dark:bg-yellow-800 text-inherit rounded-[2px] px-0.5"
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
// Scope / mode toggles
// ---------------------------------------------------------------------------
function PillToggle<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T
  options: { label: string; value: T; disabled?: boolean }[]
  onChange: (v: T) => void
  disabled?: boolean
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-full bg-muted/40 p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          disabled={disabled || opt.disabled}
          onClick={() => onChange(opt.value)}
          className={cn(
            "inline-flex h-6 items-center rounded-full px-2.5 text-[11px] font-medium tracking-tight transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
            "disabled:cursor-not-allowed disabled:opacity-40",
            value === opt.value
              ? "bg-background text-foreground shadow-sm ring-1 ring-foreground/5"
              : "text-muted-foreground hover:text-foreground",
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
  return (
    <button
      type="button"
      onClick={() => onSelect(result, query)}
      className={cn(
        "w-full text-left rounded-md px-3 py-2 text-sm transition-colors",
        "hover:bg-accent hover:text-accent-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
      )}
    >
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <span className="truncate text-xs font-medium text-muted-foreground">
          {result.fileName || result.fileId}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground/60 uppercase tracking-wide">
          {result.original ? "source" : "target"}
        </span>
      </div>
      <div className="text-sm leading-snug">
        <Snippet html={result.snippet || (result.original || result.translated)} />
      </div>
      {result.paired != null && result.paired !== "" && (
        <div className="mt-1 pl-2 border-l-2 border-muted text-xs text-muted-foreground leading-snug">
          {result.paired}
        </div>
      )}
    </button>
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
    onClear,
    onClearResults,
    onSelect,
  } = props

  const clearResults = onClearResults ?? onClear

  const [query, setQuery] = useState("")
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
    (q: string, currentScope: ParallelPanelScope) => {
      if (!q.trim()) {
        clearResults?.()
        return
      }
      const opts: SearchOptions = {
        scope: currentScope === "file" ? "file" : "project",
        fileId: currentScope === "file" ? (activeFileId ?? undefined) : undefined,
      }
      onSearch?.(q, opts)
    },
    [activeFileId, clearResults, onSearch],
  )

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    setQuery(v)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      triggerSearch(v, scope)
    }, DEBOUNCE_MS)
  }

  const handleScopeChange = (s: ParallelPanelScope) => {
    onScopeChange?.(s)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    triggerSearch(query, s)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      triggerSearch(query, scope)
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex flex-col gap-0 p-0 max-w-2xl max-h-[80vh] overflow-hidden">
        <DialogHeader className="px-4 pt-4 pb-0 shrink-0">
          <DialogTitle className="sr-only">Parallel passages search</DialogTitle>
          <div className="flex items-center justify-between gap-3 mb-3">
            <PillToggle<ParallelPanelScope>
              value={scope}
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
              options={[
                { label: "Search", value: "search" },
                { label: "Replace", value: "replace", disabled: true },
              ]}
              onChange={(m) => onModeChange?.(m)}
            />
          </div>
        </DialogHeader>

        {/* Search input */}
        <div className="px-4 pb-3 shrink-0">
          <Input
            ref={inputRef}
            placeholder={`Search ${scope === "file" ? scopeLabel.toLowerCase() : "project"}…`}
            value={query}
            onChange={handleQueryChange}
            onKeyDown={handleKeyDown}
            className="h-9 text-sm"
          />
          {scope === "file" && !activeFileId && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              Open a file to enable file-scoped search.
            </p>
          )}
          {mode === "replace" && (
            <div className="mt-2 rounded-md border border-dashed border-muted-foreground/30 px-3 py-2 text-xs text-muted-foreground">
              Bulk replace is coming soon — search works now.
            </div>
          )}
        </div>

        {/* Results */}
        <ScrollArea className="flex-1 min-h-0 border-t border-border">
          <div className="px-2 py-2 space-y-0.5">
            {loading && (
              <>
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="px-3 py-2 space-y-1.5">
                    <Skeleton className="h-3 w-1/3" />
                    <Skeleton className="h-4 w-full" />
                  </div>
                ))}
              </>
            )}

            {!loading && isIdle && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                Type to search across {scope === "file" ? "the open file" : "the project"}.
              </p>
            )}

            {!loading && isEmpty && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                No results for <span className="font-medium">{query}</span>.
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
        </ScrollArea>

        {/* Footer */}
        {!loading && results.length > 0 && (
          <div className="px-4 py-2 shrink-0 border-t border-border flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {results.length} result{results.length !== 1 ? "s" : ""}
            </span>
            <span className="text-xs text-muted-foreground">
              {scopeLabel}
            </span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
