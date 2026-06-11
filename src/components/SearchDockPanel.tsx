/**
 * SearchDockPanel.tsx — FRO-308
 *
 * Inline search/find-replace panel for the left dock.
 * Wraps the same search logic as ParallelPassagesPanel but in a
 * non-Dialog (always-visible) layout that lives in the dock.
 *
 * The heavy search internals (FTS5 queries, replace diffs) are NOT
 * duplicated here — this panel re-uses the same hook callbacks passed
 * down from ProjectWorkspace via props.
 *
 * FRO-303 note: streaming / parallel passages heavy internals remain
 * in ParallelPassagesPanel.tsx — that Dialog is still available for
 * full-screen searches. This dock panel is the quick-access surface.
 */

import { useState, useCallback, useRef, useEffect } from "react"
import { Search, Replace, BookOpen, X, Maximize2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { WorkspaceSearchResult } from "@/hooks/useWorkspaceSearch"
import type { ReplaceAllPayload } from "./ParallelPassagesPanel"

export type SearchDockMode = "search" | "replace"

export interface SearchDockPanelProps {
  activeFileId: string | null
  activeFileName: string | null
  loading: boolean
  ready: boolean
  results: WorkspaceSearchResult[]
  onReady: () => void
  onSearch: (query: string, options?: { fileId?: string; side?: "both" | "source" | "target" }) => void
  onSearchPassages: (query: string) => void
  onClearResults: () => void
  onSelect: (result: WorkspaceSearchResult, query: string) => void
  isReadOnly: boolean
  onAfterReplace?: () => void
  onReplaceAll?: (payload: ReplaceAllPayload) => void
  /** Called when user wants to open the full ParallelPassagesPanel dialog */
  onOpenFullPanel?: () => void
  /** FRO-309: Called when user wants to expand all results into the main area */
  onExpandResults?: (query: string) => void
}

export function SearchDockPanel({
  activeFileId,
  activeFileName,
  loading,
  results,
  onReady,
  onSearch,
  onClearResults,
  onSelect,
  onOpenFullPanel,
  onExpandResults,
}: SearchDockPanelProps) {
  const [mode, setMode] = useState<SearchDockMode>("search")
  const [query, setQuery] = useState("")
  const [scope, setScope] = useState<"file" | "project">(activeFileId ? "file" : "project")
  const inputRef = useRef<HTMLInputElement>(null)

  // Update scope when file changes
  useEffect(() => {
    setScope(activeFileId ? "file" : "project")
  }, [activeFileId])

  // Initialize search index on mount
  useEffect(() => {
    onReady()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSearch = useCallback(
    (q: string) => {
      if (!q.trim()) {
        onClearResults()
        return
      }
      onSearch(q, scope === "file" && activeFileId ? { fileId: activeFileId } : {})
    },
    [onSearch, onClearResults, scope],
  )

  function handleQueryChange(q: string) {
    setQuery(q)
    handleSearch(q)
  }

  function handleClear() {
    setQuery("")
    onClearResults()
    inputRef.current?.focus()
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <button
          type="button"
          title="Search"
          aria-label="Search"
          aria-pressed={mode === "search"}
          onClick={() => setMode("search")}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded transition-colors",
            mode === "search"
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Search className="h-3 w-3" />
        </button>
        <button
          type="button"
          title="Find & Replace"
          aria-label="Find & Replace"
          aria-pressed={mode === "replace"}
          onClick={() => setMode("replace")}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded transition-colors",
            mode === "replace"
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Replace className="h-3 w-3" />
        </button>

        {/* Scope toggle */}
        <div className="ml-auto flex items-center gap-0.5 rounded-full border px-1 py-0.5 text-[9px] text-muted-foreground">
          <button
            type="button"
            onClick={() => setScope("file")}
            className={cn(
              "rounded-full px-1.5 py-0.5 transition-colors",
              scope === "file" ? "bg-card text-foreground font-medium" : "hover:text-foreground",
            )}
          >
            File
          </button>
          <button
            type="button"
            onClick={() => setScope("project")}
            className={cn(
              "rounded-full px-1.5 py-0.5 transition-colors",
              scope === "project" ? "bg-card text-foreground font-medium" : "hover:text-foreground",
            )}
          >
            Project
          </button>
        </div>

        {/* Open full panel */}
        {onOpenFullPanel && (
          <button
            type="button"
            title="Open full search panel"
            aria-label="Open full search panel"
            onClick={onOpenFullPanel}
            className="ml-0.5 flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground transition-colors"
          >
            <BookOpen className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Search input */}
      <div className="relative px-2 pt-2">
        <Search className="pointer-events-none absolute left-4 top-3.5 h-3 w-3 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          placeholder={`Search ${scope === "file" && activeFileName ? activeFileName : "project"}…`}
          className="h-7 pl-7 pr-6 text-xs"
        />
        {query && (
          <button
            type="button"
            onClick={handleClear}
            className="absolute right-4 top-3 flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Results area */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        {loading && (
          <p className="py-2 text-center text-[10px] text-muted-foreground">Searching…</p>
        )}
        {!loading && query && results.length === 0 && (
          <p className="py-2 text-center text-[10px] text-muted-foreground">No results</p>
        )}
        {!loading && !query && (
          <p className="py-2 text-center text-[10px] text-muted-foreground">
            Type to search {scope === "file" ? "this file" : "the project"}
          </p>
        )}
        {results.length > 0 && (
          <div className="space-y-0.5">
            {/* FRO-309: Expand-all action */}
            {onExpandResults && (
              <div className="flex items-center justify-between pb-0.5 pt-0.5">
                <span className="text-[10px] text-muted-foreground">
                  {results.length} result{results.length !== 1 ? "s" : ""}
                </span>
                <button
                  type="button"
                  title="Expand all results in main area"
                  aria-label="Expand all results"
                  onClick={() => onExpandResults(query)}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                >
                  <Maximize2 className="h-2.5 w-2.5" />
                  Expand all
                </button>
              </div>
            )}
            {results.slice(0, 50).map((r) => (
              <button
                key={`${r.fileId}:${r.cellId}`}
                type="button"
                onClick={() => onSelect(r, query)}
                className="w-full rounded px-1.5 py-1 text-left text-xs hover:bg-accent transition-colors"
              >
                {r.context && (
                  <span className="block text-[10px] text-muted-foreground">{r.context}</span>
                )}
                <span className="block truncate">{r.snippet || r.original}</span>
              </button>
            ))}
            {results.length > 50 && (
              <p className="py-1 text-center text-[10px] text-muted-foreground">
                {results.length - 50} more — open full panel for all results
              </p>
            )}
          </div>
        )}
      </div>

      {/* Find & Replace mode: open full panel since diffs are complex */}
      {mode === "replace" && (
        <div className="border-t p-2">
          <p className="mb-1.5 text-[10px] text-muted-foreground leading-snug">
            Find &amp; Replace with diff preview lives in the full panel.
          </p>
          {onOpenFullPanel && (
            <Button
              size="sm"
              variant="outline"
              onClick={onOpenFullPanel}
              className="h-6 w-full text-[10px]"
            >
              Open Find &amp; Replace
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
