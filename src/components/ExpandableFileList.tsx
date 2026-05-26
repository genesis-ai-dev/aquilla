import { useMemo, useState } from "react"
import { Search as SearchIcon, X, ChevronDown, Pencil } from "lucide-react"
import type { FileReference } from "@/lib/parsers/types"
import { fileTypeHasSections } from "@/lib/parsers/types"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useSidebarExpansion, usePersistedToggleSet } from "@/hooks/useSidebarExpansion"
import { FileRow } from "./FileRow"
import { FileActionMenu } from "./FileActionMenu"
import { groupByCorpus } from "@/lib/sidebar/group-by-corpus"
import { useEditorScroll } from "@/context/EditorScrollContext"
import { FileSectionGrid } from "./sidebar/FileSectionGrid"
import { cn } from "@/lib/utils"

interface FileStats { translated: number; validated: number; total: number }

interface Props {
  projectId: string
  files: FileReference[]
  activeFileId: string | null
  fileProgress: Map<string, FileStats>
  suggestionFileIds: Set<string>
  validationCount: number
  getTokenForFile: (fileId: string) => Promise<string | null>
  onSelectFile: (fileId: string) => void
  onRename: (fileId: string, newName: string) => void
  onMove: (fileId: string) => void
  onDelete: (fileId: string) => void
  onApplySuggestion?: (fileId: string) => void
  onRenameCorpus?: (oldMarker: string, newMarker: string) => void
}

export function ExpandableFileList({
  projectId, files, activeFileId, fileProgress,
  suggestionFileIds, validationCount, getTokenForFile, onSelectFile, onRename, onMove, onDelete,
  onApplySuggestion, onRenameCorpus,
}: Props) {
  const { expanded, toggle } = useSidebarExpansion(projectId)
  const { members: collapsed, toggle: toggleCollapsed } = usePersistedToggleSet(
    `codex:sidebar:corpus-collapsed:${projectId}`,
  )
  const [menu, setMenu] = useState<{ fileId: string; x: number; y: number } | null>(null)
  const [editingFileId, setEditingFileId] = useState<string | null>(null)
  const [filter, setFilter] = useState("")
  const [editingCorpus, setEditingCorpus] = useState<string | null>(null)
  const { requestScrollToSection } = useEditorScroll()

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const filtered = needle ? files.filter((f) => f.name.toLowerCase().includes(needle)) : files
    return groupByCorpus(filtered)
  }, [files, filter])

  return (
    <>
      <div className="border-b px-2 py-2">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            role="searchbox"
            name="aquilla-file-filter-query"
            aria-label="Filter files"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            data-1p-ignore="true"
            data-lpignore="true"
            data-form-type="other"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter files..."
            className="h-7 w-full rounded border bg-background pl-7 pr-7 text-xs outline-none focus:ring-1 focus:ring-ring"
          />
          {filter && (
            <button
              onClick={() => setFilter("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent"
              aria-label="Clear filter"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-2 space-y-2">
          {groups.length === 0 && (
            <p className="px-2 text-sm text-muted-foreground">
              {filter ? `No files match "${filter}".` : "No files imported yet."}
            </p>
          )}
          {groups.map((group) => {
            const showHeader = groups.length > 1 || group.label !== "Ungrouped"
            const isCollapsed = showHeader && collapsed.has(group.label)
            const canEditCorpus =
              showHeader && group.label !== "Ungrouped" && onRenameCorpus !== undefined
            const isEditingCorpus = editingCorpus === group.label
            return (
              <div key={group.label}>
                {showHeader && (
                  <div className="group/corpus flex items-center gap-1 px-1 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    <button
                      type="button"
                      className="flex flex-1 items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-muted/60"
                      onClick={() => toggleCollapsed(group.label)}
                      aria-expanded={!isCollapsed}
                      aria-label={isCollapsed ? `Expand ${group.label}` : `Collapse ${group.label}`}
                    >
                      <ChevronDown
                        className={cn("h-3 w-3 transition-transform", isCollapsed && "-rotate-90")}
                      />
                      {isEditingCorpus ? (
                        <input
                          autoFocus
                          defaultValue={group.label}
                          onClick={(e) => e.stopPropagation()}
                          onBlur={(e) => {
                            const next = e.currentTarget.value.trim()
                            setEditingCorpus(null)
                            if (next && next !== group.label) onRenameCorpus?.(group.label, next)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur() }
                            else if (e.key === "Escape") { e.preventDefault(); setEditingCorpus(null) }
                          }}
                          className="flex-1 rounded border bg-background px-1 text-[11px] normal-case tracking-normal"
                        />
                      ) : (
                        <span>{group.label}</span>
                      )}
                    </button>
                    {canEditCorpus && !isEditingCorpus && (
                      <button
                        className="rounded p-0.5 opacity-0 group-hover/corpus:opacity-100 hover:bg-muted"
                        onClick={(e) => { e.stopPropagation(); setEditingCorpus(group.label) }}
                        aria-label={`Rename ${group.label}`}
                        title={`Rename ${group.label}`}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                )}
                {!isCollapsed && (
                  <div className="space-y-0.5">
                    {group.files.map((file) => {
                      const canExpand = fileTypeHasSections(file.type)
                      const isExpanded = canExpand && expanded.has(file.id)
                      const isEditing = editingFileId === file.id
                      return (
                        <div key={file.id}>
                          <FileRow
                            file={file}
                            active={file.id === activeFileId}
                            expanded={isExpanded}
                            progress={fileProgress.get(file.id)}
                            hasSuggestion={suggestionFileIds.has(file.id)}
                            editing={isEditing}
                            onEditCommit={(name) => {
                              setEditingFileId(null)
                              if (name !== file.name) onRename(file.id, name)
                            }}
                            onEditCancel={() => setEditingFileId(null)}
                            onToggleExpand={() => toggle(file.id)}
                            onSelect={() => onSelectFile(file.id)}
                            onOpenMenu={(x, y) => setMenu({ fileId: file.id, x, y })}
                            onStartRename={() => setEditingFileId(file.id)}
                            onApplySuggestion={
                              onApplySuggestion ? () => onApplySuggestion(file.id) : undefined
                            }
                          />
                          {isExpanded && (
                            <FileSectionGrid
                              projectId={projectId}
                              fileId={file.id}
                              validationCount={validationCount}
                              getTokenForFile={getTokenForFile}
                              onSectionClick={(label) => {
                                if (file.id !== activeFileId) {
                                  onSelectFile(file.id)
                                  setTimeout(() => requestScrollToSection(label), 100)
                                } else {
                                  requestScrollToSection(label)
                                }
                              }}
                            />
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </ScrollArea>
      {menu && (
        <FileActionMenu
          x={menu.x} y={menu.y}
          onClose={() => setMenu(null)}
          onRename={() => setEditingFileId(menu.fileId)}
          onMove={() => onMove(menu.fileId)}
          onDelete={() => onDelete(menu.fileId)}
        />
      )}
    </>
  )
}
