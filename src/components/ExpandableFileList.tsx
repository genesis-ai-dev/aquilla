import { useMemo, useState } from "react"
import { Search as SearchIcon, X } from "lucide-react"
import type { FileReference } from "@/lib/parsers/types"
import { fileTypeHasSections } from "@/lib/parsers/types"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useSidebarExpansion } from "@/hooks/useSidebarExpansion"
import { FileRow } from "./FileRow"
import { FileActionMenu } from "./FileActionMenu"
import { groupByCorpus } from "@/lib/sidebar/group-by-corpus"
import { useEditorScroll } from "@/context/EditorScrollContext"
import { FileSectionGrid } from "./sidebar/FileSectionGrid"

interface FileStats { translated: number; validated: number; total: number }

interface Props {
  projectId: string
  files: FileReference[]
  activeFileId: string | null
  fileProgress: Map<string, FileStats>
  suggestionFileIds: Set<string>
  validationCount: number
  onSelectFile: (fileId: string) => void
  onRename: (fileId: string, newName: string) => void
  onMove: (fileId: string) => void
  onDelete: (fileId: string) => void
}

export function ExpandableFileList({
  projectId, files, activeFileId, fileProgress,
  suggestionFileIds, validationCount, onSelectFile, onRename, onMove, onDelete,
}: Props) {
  const { expanded, toggle } = useSidebarExpansion(projectId)
  const [menu, setMenu] = useState<{ fileId: string; x: number; y: number } | null>(null)
  const [editingFileId, setEditingFileId] = useState<string | null>(null)
  const [filter, setFilter] = useState("")
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
          {groups.map((group) => (
            <div key={group.label}>
              {(groups.length > 1 || group.label !== "Ungrouped") ? (
                <div className="px-2 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </div>
              ) : null}
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
                      />
                      {isExpanded && (
                        <FileSectionGrid
                          fileId={file.id}
                          validationCount={validationCount}
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
            </div>
          ))}
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
