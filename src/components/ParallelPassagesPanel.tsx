import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Columns2, FileText, Loader2, Replace as ReplaceIcon, Search as SearchIcon } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { WorkspaceSearchResult } from "@/lib/search/workspace-index"
import { HighlightedText } from "./HighlightedText"
import {
  applyReplaceBatch,
  previewCellReplace,
  type ReplaceResult,
} from "@/lib/search/replace-action"
import type * as Y from "yjs"

export type ParallelPanelMode = "search" | "replace"
export type ParallelPanelScope = "file" | "project"

interface ParallelPassagesPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: ParallelPanelMode
  scope: ParallelPanelScope
  onScopeChange: (s: ParallelPanelScope) => void
  onModeChange: (m: ParallelPanelMode) => void

  activeFileId: string | null
  activeFileName: string | null
  activeDoc: Y.Doc | null

  loading: boolean
  ready: boolean
  results: WorkspaceSearchResult[]
  onReady: () => void | Promise<void>
  onSearch: (query: string, options: { fileId?: string }) => void
  onSelect: (result: WorkspaceSearchResult) => void

  username: string
  isReadOnly: boolean
  onAfterReplace?: () => void | Promise<void>
}

interface PendingReplace {
  total: number
  done: number
  results: ReplaceResult[]
}

export function ParallelPassagesPanel({
  open,
  onOpenChange,
  mode,
  scope,
  onScopeChange,
  onModeChange,
  activeFileId,
  activeFileName,
  activeDoc,
  loading,
  ready,
  results,
  onReady,
  onSearch,
  onSelect,
  username,
  isReadOnly,
  onAfterReplace,
}: ParallelPassagesPanelProps) {
  const [query, setQuery] = useState("")
  const [replaceText, setReplaceText] = useState("")
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [retainValidations, setRetainValidations] = useState(true)
  const [activeIndex, setActiveIndex] = useState(0)
  const [pending, setPending] = useState<PendingReplace | null>(null)
  const [lastReport, setLastReport] = useState<string | null>(null)
  const [lastSearchedQuery, setLastSearchedQuery] = useState<string | null>(null)
  const findRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setActiveIndex(0)
    setPending(null)
    setLastReport(null)
    setLastSearchedQuery(null)
    onReady()
    setTimeout(() => findRef.current?.focus(), 50)
  }, [open, onReady])

  const effectiveFileId = scope === "file" ? activeFileId : undefined

  const triggerSearch = useCallback(() => {
    const cleaned = query.trim()
    if (!cleaned || !ready) return
    onSearch(query, { fileId: effectiveFileId ?? undefined })
    setLastSearchedQuery(query)
  }, [query, ready, onSearch, effectiveFileId])

  // Re-run when scope changes only if the user has already searched at least
  // once — avoids surprising the user with auto-runs the first time around.
  useEffect(() => {
    if (lastSearchedQuery === null) return
    onSearch(lastSearchedQuery, { fileId: effectiveFileId ?? undefined })
  }, [effectiveFileId, lastSearchedQuery, onSearch])

  const isStale = query.trim().length > 0 && query !== lastSearchedQuery

  useEffect(() => {
    setActiveIndex(0)
  }, [results])

  const replaceableResults = useMemo(() => {
    if (mode !== "replace" || !query.trim()) return new Map<string, { after: string; count: number }>()
    const map = new Map<string, { after: string; count: number }>()
    for (const r of results) {
      const preview = previewCellReplace(r.translated, {
        find: query,
        replace: replaceText,
        caseSensitive,
      })
      if (preview.count > 0) map.set(`${r.fileId}:${r.cellId}`, preview)
    }
    return map
  }, [mode, results, query, replaceText, caseSensitive])

  const replaceableCount = replaceableResults.size

  const runReplace = useCallback(
    async (targets: { fileId: string; cellId: string }[]) => {
      if (!query.trim() || targets.length === 0 || isReadOnly) return
      setPending({ total: targets.length, done: 0, results: [] })
      setLastReport(null)
      try {
        const out = await applyReplaceBatch(
          targets,
          { find: query, replace: replaceText, caseSensitive, retainValidations },
          username,
          { activeFileId, activeDoc },
          (done, total) => setPending((p) => (p ? { ...p, done, total } : p)),
        )
        const succeeded = out.filter((r) => r.success).length
        const failed = out.length - succeeded
        setLastReport(
          failed === 0
            ? `Replaced ${succeeded} cell${succeeded === 1 ? "" : "s"}.`
            : `Replaced ${succeeded} / ${out.length}. ${failed} failed.`,
        )
        await onAfterReplace?.()
      } finally {
        setPending(null)
      }
    },
    [
      query,
      replaceText,
      caseSensitive,
      retainValidations,
      username,
      activeFileId,
      activeDoc,
      isReadOnly,
      onAfterReplace,
    ],
  )

  const handleReplaceAll = useCallback(() => {
    const targets = Array.from(replaceableResults.keys()).map((k) => {
      const [fileId, cellId] = k.split(":")
      return { fileId, cellId }
    })
    return runReplace(targets)
  }, [replaceableResults, runReplace])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActiveIndex((i) => Math.min(results.length - 1, i + 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (e.key === "Enter") {
      e.preventDefault()
      if (isStale) {
        triggerSearch()
        return
      }
      const r = results[activeIndex]
      if (r) {
        onSelect(r)
        onOpenChange(false)
      }
    }
  }

  const scopeLabel = scope === "file"
    ? activeFileName
      ? `This file (${activeFileName})`
      : "This file"
    : "All files"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl p-0">
        <DialogHeader className="px-4 pt-3">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Columns2 className="h-4 w-4" />
            Parallel passages
            <div className="ml-auto flex items-center gap-1">
              <Button
                variant={mode === "search" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => onModeChange("search")}
              >
                <SearchIcon className="h-3.5 w-3.5" />
                Search
              </Button>
              <Button
                variant={mode === "replace" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => onModeChange("replace")}
                disabled={isReadOnly}
                title={isReadOnly ? "Read-only project" : undefined}
              >
                <ReplaceIcon className="h-3.5 w-3.5" />
                Replace
              </Button>
            </div>
          </DialogTitle>
          <DialogDescription className="sr-only">
            Search translated and source cells across the project, with optional
            find & replace on target cells.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 border-b px-4 py-2">
          <div className="flex items-center gap-2">
            <SearchIcon className="h-4 w-4 text-muted-foreground" />
            <Input
              ref={findRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={loading ? "Building index..." : "Find in source or target..."}
              disabled={loading}
              className="border-0 bg-transparent shadow-none focus-visible:ring-0"
            />
            <Button
              size="sm"
              variant={isStale ? "default" : "secondary"}
              onClick={triggerSearch}
              disabled={loading || !ready || !query.trim()}
              className="h-7"
            >
              <SearchIcon className="h-3.5 w-3.5" />
              Search
            </Button>
          </div>
          {mode === "replace" && (
            <div className="flex items-center gap-2">
              <ReplaceIcon className="h-4 w-4 text-muted-foreground" />
              <Input
                value={replaceText}
                onChange={(e) => setReplaceText(e.target.value)}
                placeholder="Replace with..."
                disabled={loading || isReadOnly}
                className="border-0 bg-transparent shadow-none focus-visible:ring-0"
              />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <div className="flex items-center gap-1">
              <span>Scope:</span>
              <Button
                variant={scope === "file" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => onScopeChange("file")}
                disabled={!activeFileId}
                className="h-6 px-2 text-xs"
              >
                This file
              </Button>
              <Button
                variant={scope === "project" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => onScopeChange("project")}
                className="h-6 px-2 text-xs"
              >
                All files
              </Button>
            </div>
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(e) => setCaseSensitive(e.target.checked)}
                className="h-3 w-3"
              />
              Match case
            </label>
            {mode === "replace" && (
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={retainValidations}
                  onChange={(e) => setRetainValidations(e.target.checked)}
                  className="h-3 w-3"
                />
                Retain validations
              </label>
            )}
            <span className="ml-auto">{scopeLabel}</span>
          </div>
        </div>

        <div className="max-h-[55vh] min-h-[200px] overflow-auto">
          {!query.trim() ? (
            <p className="p-4 text-sm text-muted-foreground">
              {loading ? "Loading project cells..." : "Type a query, then press Enter or click Search."}
            </p>
          ) : lastSearchedQuery === null ? (
            <p className="p-4 text-sm text-muted-foreground">Press Enter or click Search to run.</p>
          ) : results.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No matches.</p>
          ) : (
            <ul>
              {results.map((r, i) => {
                const key = `${r.fileId}-${r.cellId}`
                const replaceKey = `${r.fileId}:${r.cellId}`
                const preview = replaceableResults.get(replaceKey)
                const highlights = r.matchedTokens.map((t) => ({ token: t, colorIndex: 0 }))
                return (
                  <li key={key}>
                    <div
                      className={cn(
                        "grid grid-cols-[auto,1fr,1fr,auto] gap-3 border-b px-4 py-2 text-left",
                        i === activeIndex ? "bg-accent" : "hover:bg-accent/30",
                      )}
                      onMouseEnter={() => setActiveIndex(i)}
                    >
                      <div className="flex min-w-[120px] flex-col gap-0.5 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <FileText className="h-3 w-3" />
                          <span className="truncate">{r.fileName}</span>
                        </span>
                        {r.context && <span className="truncate">{r.context}</span>}
                      </div>
                      <div className="text-sm">
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Source</div>
                        <HighlightedText text={r.original} highlights={highlights} />
                      </div>
                      <div className="text-sm">
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Target</div>
                        {r.translated ? (
                          <HighlightedText text={r.translated} highlights={highlights} />
                        ) : (
                          <span className="text-muted-foreground italic">empty</span>
                        )}
                        {mode === "replace" && preview && (
                          <div className="mt-1 rounded border border-green-600/30 bg-green-600/10 px-2 py-1 text-xs">
                            <div className="text-[10px] uppercase tracking-wide text-green-700 dark:text-green-500">
                              After replace ({preview.count})
                            </div>
                            <div className="whitespace-pre-wrap">{preview.after}</div>
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            onSelect(r)
                            onOpenChange(false)
                          }}
                          className="h-7 px-2 text-xs"
                        >
                          Jump
                        </Button>
                        {mode === "replace" && preview && !isReadOnly && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={pending !== null}
                            onClick={() => runReplace([{ fileId: r.fileId, cellId: r.cellId }])}
                            className="h-7 px-2 text-xs"
                          >
                            Replace
                          </Button>
                        )}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t px-4 py-2 text-[10px] text-muted-foreground">
          <span>
            {ready ? `${results.length} result${results.length === 1 ? "" : "s"}` : "Indexing..."}
            {mode === "replace" && query.trim() && ` · ${replaceableCount} replaceable`}
          </span>
          <div className="flex items-center gap-3">
            {pending && (
              <span className="flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" />
                Replacing {pending.done} / {pending.total}
              </span>
            )}
            {lastReport && !pending && <span>{lastReport}</span>}
            <span>↑↓ navigate · Enter jump · Esc close</span>
            {mode === "replace" && !isReadOnly && (
              <Button
                size="sm"
                disabled={replaceableCount === 0 || pending !== null}
                onClick={handleReplaceAll}
              >
                Replace all ({replaceableCount})
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
