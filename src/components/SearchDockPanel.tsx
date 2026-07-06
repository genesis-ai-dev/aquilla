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
import { Search, Replace, BookOpen, Maximize2, Book, ArrowLeft, ExternalLink } from "lucide-react"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { SegmentTabs } from "@/components/ui/tabs"
import { AppTooltip } from "@/components/ui/tooltip"
import { MarkedSnippet } from "@/components/search/MarkedSnippet"
import { ChatMarkdown } from "@/components/chat/ChatMarkdown"
import type { WorkspaceSearchResult } from "@/hooks/useWorkspaceSearch"
import type { ReplaceAllPayload } from "./ParallelPassagesPanel"
import {
  aquiferSearch,
  aquiferReadPage,
  type AquiferSearchResult,
  type AquiferPageResponse,
} from "@/lib/aquifer/client"

export type SearchDockMode = "search" | "replace" | "bible"

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
  /** Bible Aquifer reference mode — when true, a "Bible resources" mode is
   *  offered. Sourced from project settings (`bibleResourcesEnabled`). */
  bibleResourcesEnabled?: boolean
  /** Project id for the aquifer routes (required by all three). */
  projectId?: string | null
  /** Frontier session JWT accessor — mirrors how other dock panels get auth. */
  getJwt?: () => string | null
  /** Canonical ref of the focused cell (e.g. "RUT 1:8"), for quick-lookup. */
  canonicalRef?: string | null
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
  bibleResourcesEnabled = false,
  projectId,
  getJwt,
  canonicalRef,
}: SearchDockPanelProps) {
  const [mode, setMode] = useState<SearchDockMode>("search")
  const [query, setQuery] = useState("")
  const [scope, setScope] = useState<"file" | "project">(activeFileId ? "file" : "project")

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

  const searchPlaceholder = `Search ${scope === "file" && activeFileName ? activeFileName : "project"}…`

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <AppTooltip content="Search">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Search"
            aria-pressed={mode === "search"}
            onClick={() => setMode("search")}
            className={mode === "search" ? "bg-accent text-foreground" : undefined}
          >
            <Search className="h-3 w-3" />
          </Button>
        </AppTooltip>
        <AppTooltip content="Find & Replace">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Find & Replace"
            aria-pressed={mode === "replace"}
            onClick={() => setMode("replace")}
            className={mode === "replace" ? "bg-accent text-foreground" : undefined}
          >
            <Replace className="h-3 w-3" />
          </Button>
        </AppTooltip>
        {bibleResourcesEnabled && (
          <AppTooltip content="Bible resources">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Bible resources"
              aria-pressed={mode === "bible"}
              onClick={() => setMode("bible")}
              className={mode === "bible" ? "bg-accent text-foreground" : undefined}
            >
              <Book className="h-3 w-3" />
            </Button>
          </AppTooltip>
        )}

        {/* Scope toggle — only meaningful for project text search */}
        {mode !== "bible" ? (
        <>
        <SegmentTabs
          value={scope}
          aria-label="Search scope"
          className="ml-auto"
          listClassName="text-[10px]"
          options={[
            { label: "File", value: "file", disabled: !activeFileId },
            { label: "Project", value: "project" },
          ]}
          onValueChange={setScope}
        />

        {/* Open full panel */}
        {onOpenFullPanel && (
          <AppTooltip content="Open full search panel">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Open full search panel"
              onClick={onOpenFullPanel}
              className="ml-0.5"
            >
              <BookOpen className="h-3 w-3" />
            </Button>
          </AppTooltip>
        )}
        </>
        ) : (
          <span className="ml-auto" />
        )}
      </div>

      {mode === "bible" && (
        <BibleResourcesPanel
          projectId={projectId ?? null}
          getJwt={getJwt}
          canonicalRef={canonicalRef ?? null}
        />
      )}

      {mode !== "bible" && (
      <Command
        shouldFilter={false}
        className="flex min-h-0 flex-1 flex-col rounded-none bg-transparent p-0"
      >
        <div className="px-2 pt-2">
          <CommandInput
            value={query}
            onValueChange={handleQueryChange}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="text-xs"
          />
        </div>

        <CommandList className="max-h-none flex-1 overflow-y-auto px-2 py-1">
          {loading && (
            <CommandEmpty>Searching…</CommandEmpty>
          )}
          {!loading && query && results.length === 0 && (
            <CommandEmpty>No results</CommandEmpty>
          )}
          {!loading && !query && (
            <CommandEmpty>
              Type to search {scope === "file" ? "this file" : "the project"}
            </CommandEmpty>
          )}
          {results.length > 0 && (
            <CommandGroup>
              {onExpandResults && (
                <div className="flex items-center justify-between pb-0.5 pt-0.5">
                  <span className="px-2 text-[10px] text-muted-foreground">
                    {results.length} result{results.length !== 1 ? "s" : ""}
                  </span>
                  <AppTooltip content="Expand all results in main area">
                    <button
                      type="button"
                      aria-label="Expand all results"
                      onClick={() => onExpandResults(query)}
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <Maximize2 className="h-2.5 w-2.5" />
                      Expand all
                    </button>
                  </AppTooltip>
                </div>
              )}
              {results.slice(0, 50).map((r) => (
                <CommandItem
                  key={`${r.fileId}:${r.cellId}`}
                  value={`${r.fileId}:${r.cellId}`}
                  className="flex flex-col items-start rounded px-1.5 py-1 text-xs"
                  onSelect={() => onSelect(r, query)}
                >
                  {r.context && (
                    <span className="text-[10px] text-muted-foreground">{r.context}</span>
                  )}
                  <span className="block w-full truncate">
                    <MarkedSnippet text={r.snippet || r.original} />
                  </span>
                </CommandItem>
              ))}
              {results.length > 50 && (
                <CommandEmpty>
                  {results.length - 50} more — open full panel for all results
                </CommandEmpty>
              )}
            </CommandGroup>
          )}
        </CommandList>

        {mode === "replace" && (
          <div className="border-t p-2">
            <p className="mb-1.5 text-[10px] leading-snug text-muted-foreground">
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
      </Command>
      )}
    </div>
  )
}

// ── Bible resources (Aquifer) mode ─────────────────────────────────────────

/** Heuristic: only switch to ChatMarkdown when the page text already looks
 *  like markdown. The aquifer `page.text` is plain text today, so this stays
 *  on the <pre> branch — but when the API starts returning markdown the
 *  renderer swaps with no other change. */
function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)#{1,6}\s/.test(text) || /\*\*/.test(text) || /(^|\n)[-*]\s/.test(text)
}

/** Map a canonicalRef ("RUT 1:8") to the aquifer passage path
 *  "/en/passages/RUT/1/8/". Returns null when the ref isn't book ch:vs. */
function passagePathFromRef(canonicalRef: string): string | null {
  const m = /^([A-Z0-9]{2,4})\s+(\d+):(\d+)/.exec(canonicalRef.trim())
  if (!m) return null
  const [, book, chapter, verse] = m
  return `/en/passages/${book}/${chapter}/${verse}/`
}

function KindChip({ kind }: { kind: AquiferSearchResult["kind"] }) {
  return (
    <Badge variant="secondary" className="px-1.5 py-0 text-[9px] capitalize">
      {kind.replace("-", " ")}
    </Badge>
  )
}

function BibleResourcesPanel({
  projectId,
  getJwt,
  canonicalRef,
}: {
  projectId: string | null
  getJwt?: () => string | null
  canonicalRef: string | null
}) {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<AquiferSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [page, setPage] = useState<AquiferPageResponse | null>(null)
  const [pageLoading, setPageLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  const runSearch = useCallback(
    async (q: string) => {
      const jwt = getJwt?.() ?? null
      if (!q.trim() || !jwt || !projectId) {
        setResults([])
        return
      }
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      setSearching(true)
      setError(null)
      try {
        const res = await aquiferSearch(jwt, projectId, q.trim(), {
          lang: "en",
          limit: 5,
          signal: controller.signal,
        })
        setResults(res.results)
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return
        setError(err instanceof Error ? err.message : String(err))
        setResults([])
      } finally {
        if (abortRef.current === controller) setSearching(false)
      }
    },
    [getJwt, projectId],
  )

  const openPath = useCallback(
    async (path: string) => {
      const jwt = getJwt?.() ?? null
      if (!jwt || !projectId) return
      setPageLoading(true)
      setError(null)
      try {
        const res = await aquiferReadPage(jwt, projectId, path, { maxChars: 15000 })
        setPage(res)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setPageLoading(false)
      }
    },
    [getJwt, projectId],
  )

  const refPath = canonicalRef ? passagePathFromRef(canonicalRef) : null

  // Reader view — a selected result/page is open.
  if (page) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-1.5 border-b px-2 py-1.5">
          <button
            type="button"
            onClick={() => setPage(null)}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            aria-label="Back to results"
          >
            <ArrowLeft className="h-3 w-3" />
          </button>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{page.title}</span>
          <AppTooltip content="Open on bibletranslation.org">
            <a
              href={page.url}
              target="_blank"
              rel="noreferrer"
              aria-label="Open on bibletranslation.org"
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          </AppTooltip>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2 text-xs">
          {looksLikeMarkdown(page.text) ? (
            <ChatMarkdown content={page.text} />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-foreground">
              {page.text}
            </pre>
          )}
          {page.truncated && (
            <p className="mt-2 text-[10px] italic text-muted-foreground">
              Truncated — open the full page on bibletranslation.org.
            </p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Quick-lookup for the focused verse */}
      {refPath && (
        <div className="border-b px-2 py-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-6 w-full justify-start gap-1.5 text-[10px]"
            onClick={() => void openPath(refPath)}
            disabled={pageLoading}
          >
            <Book className="h-3 w-3" />
            Notes for {canonicalRef}
          </Button>
        </div>
      )}

      {/* Search input */}
      <div className="relative px-2 pt-2">
        <Search className="pointer-events-none absolute left-4 top-3.5 h-3 w-3 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            void runSearch(e.target.value)
          }}
          placeholder="Search Bible resources…"
          className="h-7 pl-7 pr-6 text-xs"
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery("")
              setResults([])
            }}
            className="absolute right-4 top-3 flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        {error && <p className="py-2 text-center text-[10px] text-destructive">{error}</p>}
        {(searching || pageLoading) && (
          <p className="py-2 text-center text-[10px] text-muted-foreground">Loading…</p>
        )}
        {!searching && !error && query && results.length === 0 && (
          <p className="py-2 text-center text-[10px] text-muted-foreground">No resources found</p>
        )}
        {!searching && !query && results.length === 0 && (
          <p className="py-2 text-center text-[10px] text-muted-foreground">
            Search bibletranslation.org for people, places, terms, and translation notes.
          </p>
        )}
        {results.length > 0 && (
          <div className="space-y-0.5">
            {results.map((r) => (
              <button
                key={r.url}
                type="button"
                onClick={() => void openPath(new URL(r.url).pathname)}
                className="w-full rounded px-1.5 py-1 text-left hover:bg-accent transition-colors"
              >
                <span className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{r.title}</span>
                  <KindChip kind={r.kind} />
                </span>
                {r.description && (
                  <span className="mt-0.5 block line-clamp-2 text-[10px] text-muted-foreground">
                    {r.description}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
