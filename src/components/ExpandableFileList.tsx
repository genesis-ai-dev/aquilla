import { useEffect, useMemo, useState } from "react"
import { Search as SearchIcon, X, ChevronDown, Pencil } from "lucide-react"
import type { FileReference } from "@/lib/parsers/types"
import { fileTypeHasSections } from "@/lib/parsers/types"
import { useSidebarExpansion, usePersistedToggleSet } from "@/hooks/useSidebarExpansion"
import { FileRow } from "./FileRow"
import { FileActionMenu } from "./FileActionMenu"
import { groupByCorpus } from "@/lib/sidebar/group-by-corpus"
import { useEditorScroll } from "@/context/EditorScrollContext"
import { FileSectionGrid } from "./sidebar/FileSectionGrid"
import { cn } from "@/lib/utils"
import { Archive } from "lucide-react"
import {
  downloadSourceFile,
  downloadProjectZip,
  SourceExportError,
} from "@/lib/sync/source-export"

const EXPORTABLE_FILE_TYPES: ReadonlySet<FileReference["type"]> = new Set(["usfm"])

interface FileStats { translated: number; validated: number; total: number }

interface Props {
  projectId: string
  /** Display name used for the project-zip filename. Falls back to projectId. */
  projectName?: string
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
  projectId, projectName, files, activeFileId, fileProgress,
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
  const [exportToast, setExportToast] = useState<{ msg: string; tone: "ok" | "err" } | null>(null)
  const [zipExporting, setZipExporting] = useState<{ done: number; total: number } | null>(null)
  const { requestScrollToSection } = useEditorScroll()

  const exportableCount = useMemo(
    () => files.filter((f) => EXPORTABLE_FILE_TYPES.has(f.type)).length,
    [files],
  )

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
      {exportableCount > 1 && (
        <div className="px-2 pt-2">
          <button
            onClick={exportAllUsfm}
            disabled={!!zipExporting}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-background py-1.5 text-xs shadow-neu-inset transition-opacity hover:opacity-80 disabled:opacity-50"
            title={`Download all ${exportableCount} .SFM books as a .zip`}
          >
            <Archive className="h-3.5 w-3.5" />
            {zipExporting
              ? `Exporting ${zipExporting.done}/${zipExporting.total}…`
              : `Export all ${exportableCount} books (.zip)`}
          </button>
        </div>
      )}
      <div className="px-2 py-2">
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
            className="h-7 w-full rounded-xl bg-background pl-7 pr-7 text-xs shadow-neu-inset outline-none"
          />
          {filter && (
            <button
              onClick={() => setFilter("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-muted-foreground transition-colors hover:text-foreground"
              aria-label="Clear filter"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
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
                          className="flex-1 rounded-lg bg-background px-1.5 text-[11px] normal-case tracking-normal shadow-neu-inset outline-none"
                        />
                      ) : (
                        <span>{group.label}</span>
                      )}
                    </button>
                    {canEditCorpus && !isEditingCorpus && (
                      <button
                        className="rounded-full p-0.5 opacity-0 transition-shadow group-hover/corpus:opacity-100 hover:shadow-neu-xs"
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
                                  // FRO-250/254: stamp the fileId so ScrollToGroupHandler
                                  // skips this request if cells still belong to the OLD file.
                                  setTimeout(() => requestScrollToSection(label, file.id), 100)
                                } else {
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
        const canExport = !!menuFile && EXPORTABLE_FILE_TYPES.has(menuFile.type)
        return (
          <FileActionMenu
            x={menu.x} y={menu.y}
            onClose={() => setMenu(null)}
            onRename={() => setEditingFileId(menu.fileId)}
            onMove={() => onMove(menu.fileId)}
            onDelete={() => onDelete(menu.fileId)}
            onExportSource={canExport ? () => exportFile(menuFile!) : undefined}
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
        projectId, fileId: file.id, downloadName: name, getToken: getTokenForFile,
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

  async function exportAllUsfm() {
    if (zipExporting) return
    setZipExporting({ done: 0, total: exportableCount })
    try {
      const result = await downloadProjectZip({
        projectId,
        projectName: projectName ?? projectId,
        files: files.map((f) => ({ id: f.id, name: f.name, type: f.type })),
        getToken: getTokenForFile,
        onProgress: (done, total) => setZipExporting({ done, total }),
      })
      const msg = result.skipped.length === 0
        ? `Exported ${result.exported} books to .zip`
        : `Exported ${result.exported}; skipped ${result.skipped.length} (older imports — re-import to enable)`
      setExportToast({ msg, tone: result.skipped.length === 0 ? "ok" : "err" })
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Project export failed."
      setExportToast({ msg, tone: "err" })
    } finally {
      setZipExporting(null)
    }
  }
}
