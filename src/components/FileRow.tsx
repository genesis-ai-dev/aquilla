import { useEffect, useRef, useState } from "react"
import { ChevronRight, MoreHorizontal, Sparkles } from "lucide-react"
import type { FileReference } from "@/lib/parsers/types"
import { cn } from "@/lib/utils"

interface FileStats { translated: number; validated: number; total: number }

interface FileRowProps {
  file: FileReference
  active: boolean
  expanded: boolean
  progress?: FileStats
  openCommentCount?: number
  hasSuggestion?: boolean
  editing: boolean
  onEditCommit: (newName: string) => void
  onEditCancel: () => void
  onToggleExpand: () => void
  onSelect: () => void
  onOpenMenu: (x: number, y: number) => void
  onStartRename: () => void
}

export function FileRow(props: FileRowProps) {
  const {
    file, active, expanded, progress, hasSuggestion, editing,
    onEditCommit, onEditCancel, onToggleExpand, onSelect, onOpenMenu, onStartRename,
  } = props
  const inputRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(file.name)

  useEffect(() => {
    if (editing) {
      setDraft(file.name)
      setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select() }, 0)
    }
  }, [editing, file.name])

  const translatedPct = progress && progress.total > 0
    ? Math.round((progress.translated / progress.total) * 100) : 0
  const validatedPct = progress && progress.total > 0
    ? Math.round((progress.validated / progress.total) * 100) : 0

  return (
    <div
      className={cn(
        "group relative flex items-center gap-1 rounded px-1 py-1 text-sm cursor-pointer",
        active ? "bg-accent" : "hover:bg-accent/50",
      )}
      onClick={() => { if (!editing) onSelect() }}
      onContextMenu={(e) => { e.preventDefault(); onOpenMenu(e.clientX, e.clientY) }}
      onKeyDown={(e) => {
        if (editing) return
        if (e.key.toLowerCase() === "r" && !e.metaKey && !e.ctrlKey) {
          e.preventDefault(); onStartRename()
        }
      }}
      tabIndex={0}
    >
      <button
        className="p-0.5 hover:bg-muted rounded"
        onClick={(e) => { e.stopPropagation(); onToggleExpand() }}
        aria-label={expanded ? "Collapse" : "Expand"}
      >
        <ChevronRight className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")} />
      </button>
      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => onEditCommit(draft)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); onEditCommit(draft) }
              else if (e.key === "Escape") { e.preventDefault(); onEditCancel() }
            }}
            className="w-full rounded border px-1 py-0 text-sm bg-background"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <>
            <div className="truncate">{file.name}</div>
            {file.originalName && (
              <div className="truncate text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
                {file.originalName}
              </div>
            )}
          </>
        )}
      </div>
      {progress && progress.total > 0 && !editing && (
        <div className="flex items-center gap-0.5 shrink-0" aria-label={`${translatedPct}% translated, ${validatedPct}% validated`}>
          <span className="h-2 w-6 rounded-full bg-muted overflow-hidden">
            <span className="block h-full bg-amber-500" style={{ width: `${translatedPct}%` }} />
          </span>
          <span className="h-2 w-6 rounded-full bg-muted overflow-hidden">
            <span className="block h-full bg-emerald-500" style={{ width: `${validatedPct}%` }} />
          </span>
        </div>
      )}
      {!editing && (
        <button
          className="p-1 rounded hover:bg-muted opacity-0 group-hover:opacity-100"
          onClick={(e) => { e.stopPropagation(); onOpenMenu(e.clientX, e.clientY) }}
          aria-label="File actions"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      )}
      {hasSuggestion && !editing && (
        <Sparkles className="h-3 w-3 text-amber-500 shrink-0" aria-label="Rename suggestion available" />
      )}
    </div>
  )
}
