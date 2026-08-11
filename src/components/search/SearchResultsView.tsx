/**
 * SearchResultsView.tsx — AQU-309
 *
 * "Expand all results" view — VS Code "open search results as editor" style.
 * Renders in the main content area as an overlay over the editor.
 *
 * Results are grouped by file. Each result row is clickable and fires
 * onJumpToResult, which the parent (ProjectWorkspace) wires to
 * jumpToCellId (same mechanism as comments/anchor scrolling).
 */

import { useMemo } from "react"
import { X, FileText, ChevronRight, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/page"
import { cn } from "@/lib/utils"
import { MarkedSnippet } from "@/components/search/MarkedSnippet"
import type { WorkspaceSearchResult } from "@/lib/search/workspace-index"
import { useT } from "@/lib/i18n/I18nProvider"

export interface SearchResultsViewProps {
  query: string
  results: WorkspaceSearchResult[]
  onJumpToResult: (result: WorkspaceSearchResult) => void
  onClose: () => void
}

interface FileGroup {
  fileId: string
  fileName: string
  results: WorkspaceSearchResult[]
}

function highlightSnippet(text: string, query: string): React.ReactNode {
  // FTS5 snippets arrive with literal <mark>...</mark> markers — render
  // those directly instead of token-matching the raw string.
  if (text.includes("<mark>")) return <MarkedSnippet text={text} />
  if (!query.trim()) return text
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!tokens.length) return text

  // Simple highlight: find first matching token and wrap it
  const lower = text.toLowerCase()
  let best: { start: number; len: number } | null = null
  for (const tok of tokens) {
    const idx = lower.indexOf(tok)
    if (idx >= 0 && (!best || idx < best.start)) {
      best = { start: idx, len: tok.length }
    }
  }
  if (!best) return text

  return (
    <>
      {text.slice(0, best.start)}
      <mark className="bg-yellow-200/60 dark:bg-yellow-700/50 rounded-[2px] px-[1px]">
        {text.slice(best.start, best.start + best.len)}
      </mark>
      {text.slice(best.start + best.len)}
    </>
  )
}

export function SearchResultsView({
  query,
  results,
  onJumpToResult,
  onClose,
}: SearchResultsViewProps) {
  const t = useT()
  const groups = useMemo<FileGroup[]>(() => {
    const map = new Map<string, FileGroup>()
    for (const r of results) {
      let g = map.get(r.fileId)
      if (!g) {
        g = { fileId: r.fileId, fileName: r.fileName, results: [] }
        map.set(r.fileId, g)
      }
      g.results.push(r)
    }
    return Array.from(map.values())
  }, [results])

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-4 py-2 shrink-0">
        <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-medium flex-1 truncate">
          {t("search.expanded.header")}
          {query && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {t("search.expanded.forQueryPrefix")} &ldquo;{query}&rdquo;
            </span>
          )}
        </span>
        <span className="text-xs text-muted-foreground shrink-0">
          {t(results.length === 1 ? "search.resultCountOne" : "search.resultCountOther", {
            count: results.length,
          })}{" "}
          {t("search.expanded.countsJoiner")}{" "}
          {t(groups.length === 1 ? "search.expanded.fileCountOne" : "search.expanded.fileCountOther", {
            count: groups.length,
          })}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label={t("search.expanded.close")}
        >
          <X />
        </Button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {results.length === 0 ? (
          <EmptyState
            variant="inline"
            className="h-full"
            icon={Search}
            title={t("search.noResults")}
          />
        ) : (
          <div className="py-2">
            {groups.map((group) => (
              <FileSection
                key={group.fileId}
                group={group}
                query={query}
                onJumpToResult={onJumpToResult}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function FileSection({
  group,
  query,
  onJumpToResult,
}: {
  group: FileGroup
  query: string
  onJumpToResult: (r: WorkspaceSearchResult) => void
}) {
  return (
    <div className="mb-1">
      {/* File header */}
      <div className="flex items-center gap-1.5 px-4 py-1 text-xs font-medium text-muted-foreground sticky top-0 bg-background/95 backdrop-blur-sm border-b border-border/50">
        <ChevronRight className="h-3 w-3 shrink-0" />
        <span className="truncate">{group.fileName}</span>
        <span className="ml-auto shrink-0 text-[10px] font-normal">
          {group.results.length}
        </span>
      </div>

      {/* Result rows */}
      {group.results.map((r) => (
        <ResultRow
          key={`${r.fileId}:${r.cellId}`}
          result={r}
          query={query}
          onJump={onJumpToResult}
        />
      ))}
    </div>
  )
}

function ResultRow({
  result,
  query,
  onJump,
}: {
  result: WorkspaceSearchResult
  query: string
  onJump: (r: WorkspaceSearchResult) => void
}) {
  const displayText = result.snippet || result.original

  return (
    <button
      type="button"
      onClick={() => onJump(result)}
      className={cn(
        "w-full text-left px-6 py-1.5 hover:bg-accent transition-colors",
        "flex flex-col gap-0.5 group",
      )}
    >
      {result.context && (
        <span className="text-[10px] text-muted-foreground truncate">{result.context}</span>
      )}
      <span className="text-xs truncate group-hover:text-foreground">
        {highlightSnippet(displayText, query)}
      </span>
      {result.paired && (
        <span className="text-[10px] text-muted-foreground/70 truncate italic">
          <MarkedSnippet text={result.paired} />
        </span>
      )}
    </button>
  )
}
