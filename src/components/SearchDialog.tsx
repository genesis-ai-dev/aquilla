import { useEffect, useRef, useState } from "react"
import { Search as SearchIcon, FileText } from "lucide-react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import type { WorkspaceSearchResult } from "@/lib/search/workspace-index"
import { HighlightedText } from "./HighlightedText"
import { cn } from "@/lib/utils"

interface SearchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onReady: () => void | Promise<void>
  loading: boolean
  ready: boolean
  results: WorkspaceSearchResult[]
  onSearch: (query: string) => void
  onSelect: (result: WorkspaceSearchResult) => void
}

export function SearchDialog({
  open, onOpenChange, onReady, loading, ready, results, onSearch, onSelect,
}: SearchDialogProps) {
  const [query, setQuery] = useState("")
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery("")
      setActiveIndex(0)
      onReady()
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open, onReady])

  useEffect(() => {
    const timer = setTimeout(() => onSearch(query), 100)
    return () => clearTimeout(timer)
  }, [query, onSearch, ready])

  useEffect(() => {
    setActiveIndex(0)
  }, [results])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActiveIndex((i) => Math.min(results.length - 1, i + 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const r = results[activeIndex]
      if (r) {
        onSelect(r)
        onOpenChange(false)
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0">
        <DialogHeader className="px-4 pt-3">
          <DialogTitle className="text-sm">Search all cells</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 border-b px-4 py-2">
          <SearchIcon className="h-4 w-4 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={loading ? "Building index..." : "Type to search..."}
            disabled={loading}
            className="border-0 bg-transparent shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="max-h-[400px] overflow-auto">
          {!query.trim() ? (
            <p className="p-4 text-sm text-muted-foreground">
              {loading ? "Loading project cells..." : "Type to search across all files."}
            </p>
          ) : results.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No matches.</p>
          ) : (
            <ul>
              {results.map((r, i) => (
                <li key={`${r.fileId}-${r.cellId}`}>
                  <button
                    onClick={() => { onSelect(r); onOpenChange(false) }}
                    onMouseEnter={() => setActiveIndex(i)}
                    className={cn(
                      "w-full border-b px-4 py-2 text-left",
                      i === activeIndex ? "bg-accent" : "hover:bg-accent/50"
                    )}
                  >
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <FileText className="h-3 w-3" />
                      <span className="truncate">{r.fileName}</span>
                      {r.context && <span>· {r.context}</span>}
                    </div>
                    <div className="mt-0.5 text-sm">
                      <HighlightedText
                        text={r.original}
                        highlights={r.matchedTokens.map((t) => ({ token: t, colorIndex: 0 }))}
                      />
                    </div>
                    {r.translated && (
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        →{" "}
                        <HighlightedText
                          text={r.translated}
                          highlights={r.matchedTokens.map((t) => ({ token: t, colorIndex: 0 }))}
                        />
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {ready && (
          <div className="border-t px-4 py-1.5 text-[10px] text-muted-foreground">
            ↑↓ navigate · Enter select · Esc close
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
