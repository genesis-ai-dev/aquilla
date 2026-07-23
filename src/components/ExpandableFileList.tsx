import { useEffect, useMemo, useState } from "react"
import { Search as SearchIcon, X, ChevronDown, Pencil, BookOpen } from "lucide-react"
import type { FileReference } from "@/lib/parsers/types"
import { fileHasSections } from "@/lib/parsers/types"
import { useSidebarExpansion, usePersistedToggleSet } from "@/hooks/useSidebarExpansion"
import { FileRow } from "./FileRow"
import { FileActionMenu } from "./FileActionMenu"
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
import {
  downloadSourceFile,
  SourceExportError,
} from "@/lib/sync/source-export"
import { prefetchFileProgress } from "@/lib/progress/file-progress-resource"

const EXPORTABLE_FILE_TYPES: ReadonlySet<FileReference["type"]> = new Set(["usfm"])

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
  onRename: (fileId: string, newName: string) => void
  onMove: (fileId: string) => void
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
  /** Render a pinned "Glossary" pseudo-file entry; invoked on click. Omit to hide. */
  onOpenGlossary?: () => void
  /** True when the glossary surface is the active center surface (for highlight). */
  glossaryActive?: boolean
}

export function ExpandableFileList({
  projectId, files, activeFileId, fileProgress,
  suggestionFileIds, validationCount, getTokenForFile, onSelectFile, onRename, onMove, onDelete,
  targetLang = "",
  onApplySuggestion, onRenameCorpus, canExportByOrgPolicy = true,
  onOpenGlossary, glossaryActive,
}: Props) {
  const { expanded, toggle } = useSidebarExpansion(projectId)
  const { members: collapsed, toggle: toggleCollapsed } = usePersistedToggleSet(
    `codex:sidebar:corpus-collapsed:${projectId}`,
  )
  const [menu, setMenu] = useState<{ fileId: string; x: number; y: number } | null>(null)
  const [editingFileId, setEditingFileId] = useState<string | null>(null)
  const [filter, setFilter] = useState("")
  const [editingCorpus, setEditingCorpus] = useState<string | null>(null)
  const [exportToast, setExportToast] = useState<{ msg: string; tone: "ok" | "err" } | null>(null)
  const { requestScrollToSection } = useEditorScroll()

  useEffect(() => {
    if (activeFileId) prefetchFileProgress(projectId, activeFileId, getTokenForFile)
    for (const fileId of expanded) prefetchFileProgress(projectId, fileId, getTokenForFile)
  }, [activeFileId, expanded, getTokenForFile, projectId])

  // Auto-dismiss the export toast after a few seconds — mirrors the Dashboard
  // errorToast pattern (no external toast lib in this codebase).
  useEffect(() => {
    if (!exportToast) return
    const t = setTimeout(() => setExportToast(null), 4500)
    return () => clearTimeout(t)
  }, [exportToast])

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
            className="text-xs"
          />
          {filter && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                type="button"
                size="icon-xs"
                onClick={() => setFilter("")}
                aria-label="Clear filter"
              >
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="p-2 space-y-2">
          {onOpenGlossary && (
            <button
              type="button"
              onClick={onOpenGlossary}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                glossaryActive ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
              )}
            >
              <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">Glossary</span>
            </button>
          )}
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
                      className="flex flex-1 items-center gap-1 rounded-lg px-1 py-0.5 text-left transition-colors hover:text-foreground"
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
                          className="flex-1 rounded-lg bg-background px-1.5 text-[11px] normal-case tracking-normal outline-none"
                        />
                      ) : (
                        <span>{group.label}</span>
                      )}
                    </button>
                    {canEditCorpus && !isEditingCorpus && (
                      <AppTooltip content={`Rename ${group.label}`} side="right">
                        <button
                          className="rounded-full p-0.5 opacity-0 transition-shadow group-hover/corpus:opacity-100"
                          onClick={(e) => { e.stopPropagation(); setEditingCorpus(group.label) }}
                          aria-label={`Rename ${group.label}`}
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
      {menu && (() => {
        const menuFile = files.find((f) => f.id === menu.fileId)
        // AQU-253 (a fix): also gate on org policy, not just file type.
        const canExportFile = !!menuFile && EXPORTABLE_FILE_TYPES.has(menuFile.type) && canExportByOrgPolicy
        return (
          <FileActionMenu
            x={menu.x} y={menu.y}
            onClose={() => setMenu(null)}
            onRename={() => setEditingFileId(menu.fileId)}
            onMove={() => onMove(menu.fileId)}
            onDelete={onDelete ? () => onDelete(menu.fileId) : undefined}
            onExportSource={canExportFile ? () => exportFile(menuFile!) : undefined}
          />
        )
      })()}
      {exportToast && (
        <div
          className={cn(
            "fixed bottom-4 right-4 z-60 max-w-md rounded border px-3 py-2 text-sm shadow-md",
            exportToast.tone === "err"
              ? "bg-destructive text-destructive-foreground"
              : "bg-background text-foreground",
          )}
        >
          {exportToast.msg}
        </div>
      )}
    </>
  )

  async function exportFile(file: FileReference) {
    const name = /\.(sfm|usfm)$/i.test(file.name) ? file.name : `${file.name}.SFM`
    try {
      await downloadSourceFile({
        projectId, fileId: file.id, downloadName: name, getToken: getTokenForFile, targetLang,
      })
      setExportToast({ msg: `Exported ${name}`, tone: "ok" })
    } catch (err) {
      const msg =
        err instanceof SourceExportError && err.status === 404
          ? "This file was imported before round-trip export was wired up. Re-import to enable it."
          : err instanceof Error
            ? `Export failed: ${err.message}`
            : "Export failed."
      setExportToast({ msg, tone: "err" })
    }
  }

}
