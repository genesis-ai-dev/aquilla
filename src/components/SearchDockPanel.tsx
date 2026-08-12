/**
 * SearchDockPanel.tsx — AQU-308
 *
 * Inline search/find-replace panel for the left dock.
 * Wraps the same search logic as ParallelPassagesPanel but in a
 * non-Dialog (always-visible) layout that lives in the dock.
 *
 * The heavy search internals (FTS5 queries, replace diffs) are NOT
 * duplicated here — this panel re-uses the same hook callbacks passed
 * down from ProjectWorkspace via props.
 *
 * AQU-303 note: streaming / parallel passages heavy internals remain
 * in ParallelPassagesPanel.tsx — that Dialog is still available for
 * full-screen searches. This dock panel is the quick-access surface.
 */

import { useState, useCallback, useRef, useEffect } from "react"
import { Search, Replace, BookOpen, Maximize2, Book, ArrowLeft, ExternalLink } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
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
  /** AQU-309: Called when user wants to expand all results into the main area */
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
  const t = useT()
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

  const searchPlaceholder =
    scope === "file" && activeFileName
      ? t("search.placeholderFile", { fileName: activeFileName })
      : t("search.placeholderProject")

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Toolbar — labeled mode switcher.
          AQU-597: the icon-only toggles (esp. the abstract lucide `Replace`
          glyph) were "hard to see and unclear what they depict, making them
          hard to explain to others." Each mode now carries a short text label
          alongside its icon, mirroring the clear labelled tabs the full
          ParallelPassagesPanel already uses. `flex-wrap` keeps the row from
          overflowing at the dock's minimum width. */}
      <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1.5">
        <AppTooltip content={t("search.mode.searchTooltip")}>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={t("nav.search")}
            aria-pressed={mode === "search"}
            onClick={() => setMode("search")}
            className={mode === "search" ? "bg-accent text-foreground" : undefined}
          >
            <Search className="h-3 w-3" />
            {t("nav.search")}
          </Button>
        </AppTooltip>
        <AppTooltip content={t("search.mode.replaceTooltip")}>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={t("search.mode.replaceTooltip")}
            aria-pressed={mode === "replace"}
            onClick={() => setMode("replace")}
            className={mode === "replace" ? "bg-accent text-foreground" : undefined}
          >
            <Replace className="h-3 w-3" />
            {t("search.mode.replace")}
          </Button>
        </AppTooltip>
        {bibleResourcesEnabled && (
          <AppTooltip content={t("search.mode.bibleTooltip")}>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={t("search.mode.bibleTooltip")}
              aria-pressed={mode === "bible"}
              onClick={() => setMode("bible")}
              className={mode === "bible" ? "bg-accent text-foreground" : undefined}
            >
              <Book className="h-3 w-3" />
              {t("search.mode.bible")}
            </Button>
          </AppTooltip>
        )}

        {/* Scope toggle — only meaningful for project text search */}
        {mode !== "bible" ? (
        <>
        <SegmentTabs
          value={scope}
          aria-label={t("search.scope.label")}
          className="ms-auto"
          listClassName="text-[10px]"
          options={[
            { label: t("common.file"), value: "file", disabled: !activeFileId },
            { label: t("common.project"), value: "project" },
          ]}
          onValueChange={setScope}
        />

        {/* Open full panel */}
        {onOpenFullPanel && (
          <AppTooltip content={t("search.openFullPanel")}>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("search.openFullPanel")}
              onClick={onOpenFullPanel}
              className="ms-0.5"
            >
              <BookOpen className="h-3 w-3" />
            </Button>
          </AppTooltip>
        )}
        </>
        ) : (
          <span className="ms-auto" />
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
            <CommandEmpty>{t("common.searching")}</CommandEmpty>
          )}
          {!loading && query && results.length === 0 && (
            <CommandEmpty>{t("search.noResults")}</CommandEmpty>
          )}
          {!loading && !query && (
            <CommandEmpty>
              {scope === "file" ? t("search.dock.typeToSearchFile") : t("search.dock.typeToSearchProject")}
            </CommandEmpty>
          )}
          {results.length > 0 && (
            <CommandGroup>
              {onExpandResults && (
                <div className="flex items-center justify-between pb-0.5 pt-0.5">
                  <span className="px-2 text-[10px] text-muted-foreground">
                    {t("search.resultCount", {
                      count: results.length,
                    })}
                  </span>
                  <AppTooltip content={t("search.dock.expandAllTooltip")}>
                    <button
                      type="button"
                      aria-label={t("search.dock.expandAllAriaLabel")}
                      onClick={() => onExpandResults(query)}
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <Maximize2 className="h-2.5 w-2.5" />
                      {t("search.dock.expandAllLabel")}
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
                  {t("search.dock.moreResults", { count: results.length - 50 })}
                </CommandEmpty>
              )}
            </CommandGroup>
          )}
        </CommandList>

        {mode === "replace" && (
          <div className="border-t p-2">
            <p className="mb-1.5 text-[10px] leading-snug text-muted-foreground">
              {t("search.dock.replaceHint")}
            </p>
            {onOpenFullPanel && (
              <Button
                size="sm"
                variant="outline"
                onClick={onOpenFullPanel}
                className="h-6 w-full text-[10px]"
              >
                {t("search.dock.openReplace")}
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
  const t = useT()
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
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => setPage(null)}
            aria-label={t("search.bible.backToResults")}
          >
            <ArrowLeft className="h-3 w-3" />
          </Button>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{page.title}</span>
          <AppTooltip content={t("search.bible.openExternal")}>
            <Button
              variant="ghost"
              size="icon-xs"
              render={
                <a href={page.url} target="_blank" rel="noreferrer" />
              }
              aria-label={t("search.bible.openExternal")}
            >
              <ExternalLink className="h-3 w-3" />
            </Button>
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
              {t("search.bible.truncated")}
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
            {t("search.bible.notesFor", { ref: canonicalRef ?? "" })}
          </Button>
        </div>
      )}

      {/* Search */}
      <Command
        shouldFilter={false}
        className="flex min-h-0 flex-1 flex-col rounded-none bg-transparent p-0"
      >
        <div className="px-2 pt-2">
          <CommandInput
            value={query}
            onValueChange={(q) => {
              setQuery(q)
              void runSearch(q)
            }}
            placeholder={t("search.bible.searchPlaceholder")}
            aria-label={t("search.bible.searchAriaLabel")}
            className="text-xs"
          />
        </div>

        <CommandList className="max-h-none flex-1 overflow-y-auto px-2 py-1">
          {error && <CommandEmpty className="text-destructive">{error}</CommandEmpty>}
          {(searching || pageLoading) && <CommandEmpty>{t("common.loading")}</CommandEmpty>}
          {!searching && !error && query && results.length === 0 && (
            <CommandEmpty>{t("search.bible.noResults")}</CommandEmpty>
          )}
          {!searching && !query && results.length === 0 && (
            <CommandEmpty>
              {t("search.bible.idleHint")}
            </CommandEmpty>
          )}
          {results.length > 0 && (
            <CommandGroup>
              {results.map((r) => (
                <CommandItem
                  key={r.url}
                  value={r.url}
                  className="flex flex-col items-start rounded px-1.5 py-1"
                  onSelect={() => void openPath(new URL(r.url).pathname)}
                >
                  <span className="flex w-full items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">{r.title}</span>
                    <KindChip kind={r.kind} />
                  </span>
                  {r.description && (
                    <span className="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground">
                      {r.description}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </div>
  )
}
