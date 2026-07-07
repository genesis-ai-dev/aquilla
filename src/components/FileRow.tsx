import { useEffect, useRef, useState } from "react"
import { ChevronRight, MoreHorizontal, Sparkles, AudioWaveform } from "lucide-react"
import type { FileReference } from "@/lib/parsers/types"
import { fileTypeHasSections, fileOrderedBy } from "@/lib/parsers/types"
import { cn } from "@/lib/utils"
import { AppTooltip } from "@/components/ui/tooltip"

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
  onApplySuggestion?: () => void
}

export function FileRow(props: FileRowProps) {
  const {
    file, active, expanded, progress, hasSuggestion, editing,
    onEditCommit, onEditCancel, onToggleExpand, onSelect, onOpenMenu, onStartRename, onApplySuggestion,
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
  const canExpand = fileTypeHasSections(file.type)
  // Timeline-segment-model: a file is either time-true (timeline spine) or
  // sequence-true (intrinsic order). Sequence is the default, so only the
  // exceptional timeline files carry a marker — repeating an icon on every
  // row says nothing.
  const isTimeOrdered = fileOrderedBy(file) === "time"
  const fileNameTooltip = file.originalName && file.originalName !== file.name
    ? `${file.name} (imported as ${file.originalName})`
    : file.name

  return (
    <div
      // Showcase label: addressable, readable target for video scripts/cursor
      // (see docs/distribution/SHOWCASE-LABELS.md). The whole row is the click
      // target that opens the file — what "click the sidebar file" should hit.
      data-showcase="sidebar.file"
      data-showcase-name={file.name}
      className={cn(
        "group relative flex h-7 items-center gap-1 rounded-lg px-2 text-[13px] cursor-pointer transition-colors",
        active ? "bg-accent text-foreground" : "hover:bg-accent",
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
      {canExpand ? (
        <AppTooltip content={expanded ? "Collapse sections" : "Expand sections"} side="right">
          <button
            className="p-0.5 rounded-full text-muted-foreground transition-colors hover:text-foreground"
            onClick={(e) => { e.stopPropagation(); onToggleExpand() }}
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            <ChevronRight className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")} />
          </button>
        </AppTooltip>
      ) : (
        <span className="w-[18px] shrink-0" aria-hidden="true" />
      )}
      {isTimeOrdered && (
        <AppTooltip content="Timeline-ordered (timecodes are the spine)" side="right">
          <span
            className="shrink-0 text-muted-foreground/70"
            aria-label="Timeline-ordered file"
          >
            <AudioWaveform className="h-3.5 w-3.5" />
          </span>
        </AppTooltip>
      )}
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
            className="w-full rounded-lg bg-background px-2 py-0.5 text-sm outline-none"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <AppTooltip content={fileNameTooltip} side="right">
            <button
              type="button"
              tabIndex={-1}
              className="block w-full truncate text-left"
              onClick={(e) => {
                e.stopPropagation()
                onSelect()
              }}
            >
              {file.name}
            </button>
          </AppTooltip>
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
        <AppTooltip content="File actions" side="right">
          <button
            className="p-1 rounded-full text-muted-foreground opacity-0 transition-colors hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
            onClick={(e) => { e.stopPropagation(); onOpenMenu(e.clientX, e.clientY) }}
            aria-label="File actions"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </AppTooltip>
      )}
      {hasSuggestion && !editing && (
        <AppTooltip content="A cleaner name was detected for this file. Click to apply, or use the Apply button at the top of the sidebar." side="right" className="max-w-xs">
          <button
            className="p-1 rounded-full shrink-0 transition-colors hover:text-foreground"
            onClick={(e) => { e.stopPropagation(); onApplySuggestion?.() }}
            aria-label="Apply rename suggestion"
          >
            <Sparkles className="h-3 w-3 text-amber-500" />
          </button>
        </AppTooltip>
      )}
    </div>
  )
}
