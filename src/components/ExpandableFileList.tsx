import { useEffect, useMemo, useState } from "react"
import { Search as SearchIcon, X, ChevronDown, Pencil } from "lucide-react"
import type { FileReference } from "@/lib/parsers/types"
import { fileHasSections } from "@/lib/parsers/types"
import { useSidebarExpansion, usePersistedToggleSet } from "@/hooks/useSidebarExpansion"
import { FileRow } from "./FileRow"
import { groupByCorpus } from "@/lib/sidebar/group-by-corpus"
import { useEditorScroll } from "@/context/EditorScrollContext"
import { FileSectionGrid } from "./sidebar/FileSectionGrid"
import { cn } from "@/lib/utils"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { AppTooltip } from "@/components/ui/tooltip"
import { prefetchFileProgress } from "@/lib/progress/file-progress-resource"
import { canExportSourceFile, exportSourceFile } from "@/lib/file-source-export"
import type { BookHealthChapter } from "./sidebar/BookHealthSpine"
import { useT } from "@/lib/i18n/I18nProvider"

interface FileStats { translated: number; validated: number; total: number }

interface Props {
  projectId: string
  files: FileReference[]
  activeFileId: string | null
  fileProgress: Map<string, FileStats>
  suggestionFileIds: Set<string>
  validationCount: number
  getTokenForFile: (fileId: string) => Promise<string | null>
  /** Storage lane used when exporting translated source files. */
  targetLang?: string
  onSelectFile: (fileId: string, opts?: { sectionLabel?: string }) => void
  /** Opens the FileDetailsModal for the given file (rendered by the caller). */
  onShowDetails?: (fileId: string) => void
  onRename: (fileId: string, newName: string) => void
  onMove: (fileId: string) => void
  /** Opens the Export dialog for the given file. */
  onExport?: (fileId: string) => void
  /** Opens Assign work scoped to the given file. Hidden when omitted. */
  onAssignWork?: (fileId: string) => void
  /** AQU-271: Optional — pass undefined to hide delete for roles below project_lead (500). */
  onDelete?: (fileId: string) => void
  onApplySuggestion?: (fileId: string) => void
  onRenameCorpus?: (oldMarker: string, newMarker: string) => void
  /**
   * AQU-253 (a fix): whether org policy allows export. When false, the
   * per-file export menu items are hidden so dashboard affordances match
   * the workspace. Defaults to true (no gate) for callers that haven't
   * wired up org settings.
   */
  canExportByOrgPolicy?: boolean
  /** When set, opens inline rename for the given file (sidebar + file-options menu). */
  renameSignal?: { fileId: string; nonce: number } | null
  activeChapterHealth?: BookHealthChapter[]
}

export function ExpandableFileList({
  projectId, files, activeFileId, fileProgress,
  suggestionFileIds, validationCount, getTokenForFile, onSelectFile, onShowDetails, onRename, onMove, onExport, onAssignWork, onDelete,
  targetLang = "",
  onApplySuggestion, onRenameCorpus, canExportByOrgPolicy = true,
  renameSignal, activeChapterHealth,
}: Props) {
  const t = useT()
  const { expanded, toggle } = useSidebarExpansion(projectId)
  const { members: collapsed, toggle: toggleCollapsed } = usePersistedToggleSet(
    `codex:sidebar:corpus-collapsed:${projectId}`,
  )
  const [editingFileId, setEditingFileId] = useState<string | null>(null)
  useEffect(() => {
    if (renameSignal?.fileId) setEditingFileId(renameSignal.fileId)
  }, [renameSignal?.fileId, renameSignal?.nonce])
  const [filter, setFilter] = useState("")
  const [editingCorpus, setEditingCorpus] = useState<string | null>(null)
  const { requestScrollToSection } = useEditorScroll()

  useEffect(() => {
    if (activeFileId) prefetchFileProgress(projectId, activeFileId, getTokenForFile)
    for (const fileId of expanded) prefetchFileProgress(projectId, fileId, getTokenForFile)
  }, [activeFileId, expanded, getTokenForFile, projectId])

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const filtered = needle ? files.filter((f) => f.name.toLowerCase().includes(needle)) : files
    return groupByCorpus(filtered)
  }, [files, filter])

  return (
    <>
      <div className="px-2 py-2">
        <InputGroup className="h-7 rounded-xl">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            type="text"
            role="searchbox"
            name="aquilla-file-filter-query"
            aria-label={t("nav.fileList.filterFiles")}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            data-1p-ignore="true"
            data-lpignore="true"
            data-form-type="other"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("nav.fileList.filterPlaceholder")}
            className="text-xs"
          />
          {filter && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                type="button"
                size="icon-xs"
                onClick={() => setFilter("")}
                aria-label={t("nav.fileList.clearFilter")}
              >
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="p-2 space-y-2">
          {groups.length === 0 && (
            <p className="px-2 text-sm text-muted-foreground">
              {filter
                ? t("nav.fileList.noFilesMatch", { filter })
                : t("nav.fileList.noFilesImported")}
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
                  <div className="group/corpus flex items-center gap-1 px-1 pb-1 text-[10px] text-muted-foreground">
                    <button
                      type="button"
                      className="flex flex-1 items-center gap-1 rounded-lg px-1 py-0.5 text-left transition-colors hover:text-foreground"
                      onClick={() => toggleCollapsed(group.label)}
                      aria-expanded={!isCollapsed}
                      aria-label={
                        isCollapsed
                          ? t("nav.fileList.expandGroup", { group: group.label })
                          : t("nav.fileList.collapseGroup", { group: group.label })
                      }
                    >
                      <ChevronDown
                        className={cn("h-3 w-3 transition-transform", isCollapsed && "-rotate-90")}
                      />
                      {isEditingCorpus ? (
                        <input
                          autoFocus
                          autoComplete="off"
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
                          className="flex-1 rounded-lg bg-background px-1.5 text-[11px] normal-case tracking-normal outline-none"
                        />
                      ) : (
                        <span>{group.label}</span>
                      )}
                    </button>
                    {canEditCorpus && !isEditingCorpus && (
                      <AppTooltip content={t("nav.fileList.renameGroup", { group: group.label })} side="right">
                        <button
                          className="rounded-md p-0.5 opacity-0 transition-shadow group-hover/corpus:opacity-100"
                          onClick={(e) => { e.stopPropagation(); setEditingCorpus(group.label) }}
                          aria-label={t("nav.fileList.renameGroup", { group: group.label })}
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                      </AppTooltip>
                    )}
                  </div>
                )}
                {!isCollapsed && (
                  <div className="space-y-0.5">
                    {group.files.map((file) => {
                      const canExpand = fileHasSections(file)
                        || (file.id === activeFileId && Boolean(activeChapterHealth?.length))
                      const isExpanded = canExpand && expanded.has(file.id)
                      const isEditing = editingFileId === file.id
                      return (
                        <div
                          key={file.id}
                          onPointerEnter={() => prefetchFileProgress(projectId, file.id, getTokenForFile)}
                          onFocusCapture={() => prefetchFileProgress(projectId, file.id, getTokenForFile)}
                        >
                          <FileRow
                            file={file}
                            active={file.id === activeFileId}
                            expanded={isExpanded}
                            expandable={canExpand}
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
                            onShowDetails={onShowDetails ? () => onShowDetails(file.id) : undefined}
                            onStartRename={() => setEditingFileId(file.id)}
                            onMove={() => onMove(file.id)}
                            onExport={onExport ? () => onExport(file.id) : undefined}
                            onAssignWork={onAssignWork ? () => onAssignWork(file.id) : undefined}
                            onDelete={onDelete ? () => onDelete(file.id) : undefined}
                            onExportSource={
                              canExportSourceFile(file, canExportByOrgPolicy)
                                ? () => { void exportFile(file) }
                                : undefined
                            }
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
                              chapters={file.id === activeFileId ? activeChapterHealth : undefined}
                              onSectionClick={(label) => {
                                if (file.id !== activeFileId) {
                                  onSelectFile(file.id, { sectionLabel: label })
                                  // AQU-250/254: stamp the fileId so ScrollToGroupHandler
                                  // skips this request if cells still belong to the OLD file.
                                  setTimeout(() => requestScrollToSection(label, file.id), 100)
                                } else {
                                  onSelectFile(file.id, { sectionLabel: label })
                                  requestScrollToSection(label, file.id)
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
      </div>
    </>
  )

  async function exportFile(file: FileReference) {
    await exportSourceFile({
      projectId,
      file,
      getToken: getTokenForFile,
      targetLang,
    })
  }

}
