import { useMemo, useState } from "react"
import type { FileReference } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useSidebarExpansion } from "@/hooks/useSidebarExpansion"
import { FileRow } from "./FileRow"
import { SectionRow } from "./SectionRow"
import { FileActionMenu } from "./FileActionMenu"
import { groupByCorpus } from "@/lib/sidebar/group-by-corpus"
import { useEditorScroll } from "@/context/EditorScrollContext"

interface FileStats { translated: number; validated: number; total: number }

interface Props {
  projectId: string
  files: FileReference[]
  activeFileId: string | null
  activeFileCells: CellData[]
  fileProgress: Map<string, FileStats>
  suggestionFileIds: Set<string>
  onSelectFile: (fileId: string) => void
  onRename: (fileId: string, newName: string) => void
  onMove: (fileId: string) => void
  onDelete: (fileId: string) => void
}

export function ExpandableFileList({
  projectId, files, activeFileId, activeFileCells, fileProgress,
  suggestionFileIds, onSelectFile, onRename, onMove, onDelete,
}: Props) {
  const { expanded, toggle } = useSidebarExpansion(projectId)
  const [menu, setMenu] = useState<{ fileId: string; x: number; y: number } | null>(null)
  const [editingFileId, setEditingFileId] = useState<string | null>(null)
  const { requestScrollToGroup } = useEditorScroll()
  const groups = useMemo(() => groupByCorpus(files), [files])

  function sectionsFor(fileId: string) {
    if (fileId !== activeFileId || activeFileCells.length === 0) return []
    const byGroup = new Map<string, FileStats>()
    for (const c of activeFileCells) {
      const key = c.group || "Ungrouped"
      const s = byGroup.get(key) ?? { translated: 0, validated: 0, total: 0 }
      s.total += 1
      if (c.translated) s.translated += 1
      if (c.status === "validated") s.validated += 1
      byGroup.set(key, s)
    }
    return Array.from(byGroup.entries()).map(([label, stats]) => ({ label, ...stats }))
  }

  return (
    <>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-2 space-y-2">
          {groups.length === 0 && (
            <p className="px-2 text-sm text-muted-foreground">No files imported yet.</p>
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
                  const isExpanded = expanded.has(file.id)
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
                      {isExpanded && sectionsFor(file.id).map((s) => (
                        <SectionRow
                          key={s.label}
                          label={s.label}
                          translated={s.translated}
                          validated={s.validated}
                          total={s.total}
                          onClick={() => {
                            onSelectFile(file.id)
                            requestScrollToGroup(s.label)
                          }}
                        />
                      ))}
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
