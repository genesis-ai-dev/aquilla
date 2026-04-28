import { useMemo, useState } from "react"
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
  onAddTarget?: (sourceFileId: string) => void
}

export function ExpandableFileList({
  projectId, files, activeFileId, fileProgress,
  suggestionFileIds, validationCount, onSelectFile, onRename, onMove, onDelete, onAddTarget,
}: Props) {
  const { expanded, toggle } = useSidebarExpansion(projectId)
  const [menu, setMenu] = useState<{ fileId: string; x: number; y: number } | null>(null)
  const [editingFileId, setEditingFileId] = useState<string | null>(null)
  const { requestScrollToSection } = useEditorScroll()
  const groups = useMemo(() => groupByCorpus(files), [files])

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
      {menu && (() => {
        const menuFile = files.find((f) => f.id === menu.fileId)
        const canAddTarget = menuFile?.kind === "source" && Boolean(onAddTarget)
        return (
          <FileActionMenu
            x={menu.x} y={menu.y}
            onClose={() => setMenu(null)}
            onRename={() => setEditingFileId(menu.fileId)}
            onMove={() => onMove(menu.fileId)}
            onDelete={() => onDelete(menu.fileId)}
            onAddTarget={canAddTarget ? () => onAddTarget!(menu.fileId) : undefined}
          />
        )
      })()}
    </>
  )
}
