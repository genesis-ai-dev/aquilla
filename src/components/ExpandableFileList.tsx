import { useEffect, useMemo, useRef, useState } from "react"
import type { DragEndEvent, DragOverEvent, DragStartEvent } from "@dnd-kit/core"
import { Search as SearchIcon, X, ChevronDown, Pencil, RotateCcw } from "lucide-react"
import type { FileReference } from "@/lib/parsers/types"
import { fileHasSections } from "@/lib/parsers/types"
import { useSidebarExpansion, usePersistedToggleSet } from "@/hooks/useSidebarExpansion"
import { FileRow } from "./FileRow"
import { groupByCorpus, isCustomCorpusLabel } from "@/lib/sidebar/group-by-corpus"
import {
  hasPlacedFiles,
  planFileInsert,
  planFileMove,
  planFileNudge,
  planFileOrderReset,
  type SortIndexWrite,
} from "@/lib/sidebar/file-sort-index"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { useEditorScroll } from "@/context/EditorScrollContext"
import {
  CorpusGroupFrame,
  FileDragPreview,
  FileListRow,
  FileReorderDnd,
  GroupFileRows,
} from "./file-list-dnd"
import { readSidebarGroup, resolveSidebarFileDrop } from "./file-list-dnd-model"
import { FileSectionGrid } from "./sidebar/FileSectionGrid"
import { cn } from "@/lib/utils"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { AppTooltip } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { prefetchFileProgress } from "@/lib/progress/file-progress-resource"
import { downloadImportedOriginal } from "@/lib/file-original-download"
import { useOriginalSourceFlags } from "@/hooks/useOriginalSourceFlags"
import type { BookHealthChapter } from "./sidebar/BookHealthSpine"
import { useT } from "@/lib/i18n/I18nProvider"
import { shouldDimUnassigned } from "@/lib/assignments/assigned-files"
import type { FileFilterFocusHandle } from "@/hooks/useFileFilterFocus"

interface FileStats { translated: number; validated: number; total: number }

/** What the Reset-order confirmation needs to remember while it is open: which
 *  group is being reset, how to label it, and the writes that will clear it. */
interface CorpusGroupForReset {
  label: string
  displayLabel: string
  writes: SortIndexWrite[]
}

/** Stable empty set, so an omitted `assignedFileIds` doesn't allocate per render. */
const EMPTY_ASSIGNED: ReadonlySet<string> = new Set<string>()

interface Props {
  projectId: string
  files: FileReference[]
  activeFileId: string | null
  fileProgress: Map<string, FileStats>
  suggestionFileIds: Set<string>
  validationCount: number
  /** AQU-1083: the project's effective structural-cell policy, forwarded to
   *  each expanded file's section grid so a flip revalidates its snapshot. */
  countStructural?: boolean
  getTokenForFile: (fileId: string) => Promise<string | null>
  onSelectFile: (fileId: string, opts?: { sectionLabel?: string }) => void
  /** Opens the FileDetailsModal for the given file (rendered by the caller). */
  onShowDetails?: (fileId: string) => void
  onRename: (fileId: string, newName: string) => void
  onMove: (fileId: string) => void
  /** Opens the Export dialog for the given file. */
  onExport?: (fileId: string) => void
  /** Opens Assign work scoped to the given file. Hidden when omitted. */
  onAssignWork?: (fileId: string) => void
  /**
   * AQU-894: the files the CURRENT USER holds an open assignment on, from
   * `assignedFileIds()`. Every other row is de-emphasised so "mine" is obvious
   * in a project with many files — but only while this set is non-empty, so a
   * team that doesn't assign, and a member with nothing assigned yet, both see
   * an ordinary file list instead of a wall of grey.
   *
   * Omit it (or pass an empty set) to switch the treatment off entirely.
   */
  assignedFileIds?: ReadonlySet<string>
  /** Opens the Segmentation dialog for the given file (rendered by the caller). */
  onSegmentation?: (fileId: string) => void
  /** AQU-271: Optional — pass undefined to hide delete for roles below project_lead (500). */
  onDelete?: (fileId: string) => void
  onApplySuggestion?: (fileId: string) => void
  onRenameCorpus?: (oldMarker: string, newMarker: string) => void
  /**
   * AQU-1326: hold each expanded row's per-file `/progress` read until the
   * editor's first cell page has painted, so the sidebar doesn't take a
   * connection slot from the cell stream on file open.
   */
  deferSectionProgress?: boolean
  /**
   * AQU-253 (a fix): whether org policy allows export. When false, the
   * per-file export menu items are hidden so dashboard affordances match
   * the workspace. Defaults to true (no gate) for callers that haven't
   * wired up org settings.
   */
  canExportByOrgPolicy?: boolean
  hasActiveChapters?: boolean
  getActiveChapterHealth?: () => BookHealthChapter[]
  /**
   * AQU-1531: lets another surface put the keyboard cursor in the filter box —
   * the Agent workbench's "Choose file" button, whose only other effect (show
   * the Files panel) is invisible when the panel is already showing.
   */
  filterFocus?: FileFilterFocusHandle
  /**
   * AQU-1569: whether this member may give the project's files a hand-placed
   * order. PROJECT_LEAD+ — a reorder rewrites the sidebar everyone reads.
   *
   * False withholds the affordances entirely (no grip, no Move up/down, no
   * Reset order) rather than letting them fail on the server, which is what
   * the acceptance criterion asks for and what stops a contributor wedging
   * the outbox on a guaranteed 403.
   */
  canReorderFiles?: boolean
  /**
   * Persist a batch of hand-placed positions. Called with the output of
   * `planFileMove` / `planFileNudge` / `planFileOrderReset`, never with
   * positions computed here — the arithmetic lives in one tested module.
   */
  onReorderFiles?: (writes: SortIndexWrite[]) => void
  /**
   * Move one file into another custom corpus and place it at the slot the
   * pointer let go of. `writes` is the output of `planFileInsert` for the
   * target group. Old and New Testament folders never take this path.
   */
  onTransferFile?: (fileId: string, corpus: string, writes: SortIndexWrite[]) => void
}

export function ExpandableFileList({
  projectId, files, activeFileId, fileProgress,
  suggestionFileIds, validationCount, countStructural, getTokenForFile, onSelectFile, onShowDetails, onRename, onMove, onExport, onAssignWork, onSegmentation, onDelete,
  assignedFileIds,
  onApplySuggestion, onRenameCorpus, canExportByOrgPolicy = true,
  hasActiveChapters, getActiveChapterHealth,
  deferSectionProgress,
  filterFocus,
  canReorderFiles = false,
  onReorderFiles,
  onTransferFile,
}: Props) {
  const t = useT()
  const { expanded, toggle } = useSidebarExpansion(projectId)
  const { members: collapsed, toggle: toggleCollapsed } = usePersistedToggleSet(
    `aquilla:sidebar:corpus-collapsed:${projectId}`,
  )
  const [editingFileId, setEditingFileId] = useState<string | null>(null)
  const [filter, setFilter] = useState("")
  const [editingCorpus, setEditingCorpus] = useState<string | null>(null)
  const { requestScrollToSection } = useEditorScroll()
  // AQU-1531: the dock mounts only the active panel, so a "Choose file" click
  // that opens this panel can only be answered from here, once the box exists.
  const filterInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!filterFocus) return
    filterFocus.register(() => filterInputRef.current?.focus())
    return () => filterFocus.register(null)
  }, [filterFocus])
  const originalSourceIds = useOriginalSourceFlags(projectId, files, getTokenForFile)
  // AQU-894: see shouldDimUnassigned — false is the state that leaves every
  // row alone, and it is what an unassigned caller and a non-assigning team
  // both land in without either of them configuring anything. An omitted prop
  // collapses into the same "nothing assigned" case rather than a second one.
  const assigned = assignedFileIds ?? EMPTY_ASSIGNED
  const dimUnassigned = shouldDimUnassigned(assigned)

  // AQU-1326: this prefetch is deliberately eager, but on a file OPEN it lands
  // just ahead of the cell stream and takes a slot from it — the sidebar's
  // progress spine is not what the user is waiting for. Held until the editor's
  // first cell page has painted; the effect re-runs the moment that flips, so
  // the prefetch still happens, just behind the cells.
  useEffect(() => {
    if (deferSectionProgress) return
    if (activeFileId) prefetchFileProgress(projectId, activeFileId, getTokenForFile)
    for (const fileId of expanded) prefetchFileProgress(projectId, fileId, getTokenForFile)
  }, [activeFileId, deferSectionProgress, expanded, getTokenForFile, projectId])

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const filtered = needle ? files.filter((f) => f.name.toLowerCase().includes(needle)) : files
    return groupByCorpus(filtered)
  }, [files, filter])

  // AQU-1084: one-click jump to a Testament for full-Bible projects. Decided
  // with QA (2026-09-02): the control never hides or collapses anything on the
  // user's behalf — it expands the chosen group if it was collapsed and scrolls
  // its header to the top, and leaves the other group exactly as the user had
  // it. Offered only when both testaments are present (unfiltered), since with
  // one there is nothing to jump past.
  const showTestamentJump = useMemo(() => {
    const labels = new Set(groupByCorpus(files).map((g) => g.label))
    return labels.has("OT") && labels.has("NT")
  }, [files])
  // AQU-1569 — hand-placed file order.
  //
  // Deliberately OFF while the filter box has text. `planFileMove` positions a
  // file within the list it is given, and under a filter that list is a subset:
  // a renumber computed over it would stamp indices that push every hidden file
  // of the group to the end. Reordering a list you can only partly see is also
  // not a thing anyone means to do.
  const reorderEnabled = canReorderFiles && onReorderFiles !== undefined && filter.trim() === ""
  const canTransferBetweenCustom = reorderEnabled
    && groups.filter((group) => isCustomCorpusLabel(group.label, group.derived === true)).length >= 2
  const [drag, setDrag] = useState<{ fileId: string; group: string } | null>(null)
  const [dropHover, setDropHover] = useState<{ kind: "refuse" | "transfer"; group: string } | null>(null)
  const [resetGroup, setResetGroup] = useState<CorpusGroupForReset | null>(null)

  function endDrag() {
    setDrag(null)
    setDropHover(null)
  }

  function submit(writes: SortIndexWrite[]) {
    if (writes.length > 0) onReorderFiles?.(writes)
  }

  function handleDragStart(event: DragStartEvent) {
    const group = readSidebarGroup(event.active.data.current)
    if (group === null) return
    setDrag({ fileId: String(event.active.id), group })
  }

  function handleDragOver(event: DragOverEvent) {
    const resolution = resolveSidebarFileDrop(event.active, event.over)
    const next = resolution.kind === "refuse"
      ? { kind: "refuse" as const, group: resolution.group }
      : resolution.kind === "transfer"
        ? { kind: "transfer" as const, group: resolution.toGroup }
        : null
    setDropHover((current) =>
      current?.kind === next?.kind && current?.group === next?.group ? current : next,
    )
  }

  function handleDragEnd(event: DragEndEvent) {
    const resolution = resolveSidebarFileDrop(event.active, event.over)
    endDrag()
    if (resolution.kind === "move") {
      const target = groups.find((group) => group.label === resolution.group)
      if (!target) return
      submit(planFileMove(target.files, resolution.fileId, resolution.toPosition))
      return
    }
    if (resolution.kind !== "transfer") return
    const target = groups.find((group) => group.label === resolution.toGroup)
    if (!target) return
    if (collapsed.has(resolution.toGroup)) toggleCollapsed(resolution.toGroup)
    onTransferFile?.(
      resolution.fileId,
      resolution.toGroup,
      planFileInsert(target.files, resolution.fileId, resolution.toPosition),
    )
  }

  const draggedName = drag ? files.find((file) => file.id === drag.fileId)?.name ?? "" : ""

  const groupEls = useRef(new Map<string, HTMLDivElement>())
  const visibleGroupLabels = useMemo(() => new Set(groups.map((g) => g.label)), [groups])
  function jumpToGroup(label: string) {
    if (collapsed.has(label)) toggleCollapsed(label)
    groupEls.current.get(label)?.scrollIntoView({ block: "start" })
  }

  return (
    <>
      <div className="px-2 py-2">
        <InputGroup className="h-7 rounded-xl">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            ref={filterInputRef}
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
        {showTestamentJump && (
          <ButtonGroup
            aria-label={t("nav.fileList.jumpToTestament")}
            className="mt-2 w-full *:flex-1"
          >
            {/* i18n-exempt: "OT"/"NT" are the groups' identity strings (see
                CorpusGroup.label); only the button text is translated. */}
            {(["OT", "NT"] as const).map((testament) => (
              <Button
                key={testament}
                type="button"
                variant="outline"
                size="xs"
                disabled={!visibleGroupLabels.has(testament)}
                onClick={() => jumpToGroup(testament)}
              >
                {testament === "OT"
                  ? t("importExport.helloao.presetOldTestament")
                  : t("importExport.helloao.presetNewTestament")}
              </Button>
            ))}
          </ButtonGroup>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <FileReorderDnd
          enabled={reorderEnabled}
          overlay={draggedName ? <FileDragPreview name={draggedName} /> : null}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={endDrag}
        >
        <div className="p-2 space-y-2">
          {groups.length === 0 && (
            <p className="px-2 text-sm text-muted-foreground">
              {filter
                ? t("nav.fileList.noFilesMatch", { filter })
                : t("nav.fileList.noFilesImported")}
            </p>
          )}
          {groups.map((group) => {
            // group.label is the stable identity string (compared/keyed on
            // below); group.labelKey, set only on the synthetic "Ungrouped"
            // bucket, is what's actually shown to the user.
            const displayLabel = group.labelKey ? t(group.labelKey) : group.label
            const showHeader = groups.length > 1 || group.label !== "Ungrouped"
            const isCollapsed = showHeader && collapsed.has(group.label)
            // Derived groups (members grouped by bookCode, not by their own
            // corpusMarker) can't be renamed: renameCorpus would skip them.
            const canEditCorpus =
              showHeader && group.label !== "Ungrouped" && onRenameCorpus !== undefined && !group.derived
            const isEditingCorpus = editingCorpus === group.label
            // AQU-1569: a group of one has nothing to reorder, and "Reset
            // order" only means something once a file in it has been placed.
            // A lone file in a custom corpus can still be dragged into another
            // custom corpus — that is the drag that replaces "Move to corpus…"
            // for those groups. Testament folders never accept that drop.
            const canReorderGroup = reorderEnabled && group.files.length > 1
            const acceptsTransfer = canTransferBetweenCustom
              && isCustomCorpusLabel(group.label, group.derived === true)
            const rowSortable = canReorderGroup || acceptsTransfer
            const canResetGroup = reorderEnabled && hasPlacedFiles(group.files)
            const isRefusing = dropHover?.kind === "refuse" && dropHover.group === group.label
            const isReceiving = dropHover?.kind === "transfer" && dropHover.group === group.label
            // A project whose files are all ungrouped shows no header
            // (showHeader is false), but its one group can still be given an
            // order — so the control cannot live only inside the header, or
            // that project would have no way back to the automatic order.
            const resetOrderButton = (
              <AppTooltip content={t("nav.fileList.resetOrder", { group: displayLabel })} side="right">
                <button
                  type="button"
                  className="rounded-md p-0.5 transition-colors hover:text-foreground"
                  // Confirmed before it runs: the hand-placed order is work,
                  // it is shared with the whole project, and clearing it
                  // cannot be undone from here.
                  onClick={(e) => {
                    e.stopPropagation()
                    setResetGroup({
                      label: group.label,
                      displayLabel,
                      writes: planFileOrderReset(group.files),
                    })
                  }}
                  aria-label={t("nav.fileList.resetOrder", { group: displayLabel })}
                >
                  <RotateCcw className="h-3 w-3" />
                </button>
              </AppTooltip>
            )
            return (
              // The group is the drop boundary. A custom corpus accepts a file
              // from another custom corpus. A testament folder and Ungrouped
              // stay refusals — those still go through "Move to corpus…".
              <CorpusGroupFrame
                key={group.label}
                droppable={reorderEnabled}
                label={group.label}
                acceptsFileTransfer={acceptsTransfer}
                receiving={isReceiving}
                groupRef={(el) => {
                  if (el) groupEls.current.set(group.label, el)
                  else groupEls.current.delete(group.label)
                }}
              >
                {showHeader && (
                  <div className="group/corpus flex items-center gap-1 px-1 pb-1 text-[10px] text-muted-foreground">
                    <button
                      type="button"
                      className="flex flex-1 items-center gap-1 rounded-lg px-1 py-0.5 text-start transition-colors hover:text-foreground"
                      onClick={() => toggleCollapsed(group.label)}
                      aria-expanded={!isCollapsed}
                      aria-label={
                        isCollapsed
                          ? t("nav.fileList.expandGroup", { group: displayLabel })
                          : t("nav.fileList.collapseGroup", { group: displayLabel })
                      }
                    >
                      <ChevronDown
                        className={cn("h-3 w-3", isCollapsed && "-rotate-90")}
                      />
                      {!isEditingCorpus && <span>{displayLabel}</span>}
                    </button>
                    {isEditingCorpus && (
                        <input
                          autoFocus
                          autoComplete="off"
                          aria-label={t("nav.fileList.renameGroup", { group: displayLabel })}
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
                    )}
                    {canEditCorpus && !isEditingCorpus && (
                      <AppTooltip content={t("nav.fileList.renameGroup", { group: displayLabel })} side="right">
                        <button
                          type="button"
                          className="rounded-md p-0.5 transition-colors hover:text-foreground"
                          onClick={(e) => { e.stopPropagation(); setEditingCorpus(group.label) }}
                          aria-label={t("nav.fileList.renameGroup", { group: displayLabel })}
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                      </AppTooltip>
                    )}
                    {canResetGroup && !isEditingCorpus && resetOrderButton}
                  </div>
                )}
                {!showHeader && canResetGroup && (
                  <div className="flex justify-end px-1 pb-1 text-[10px] text-muted-foreground">
                    {resetOrderButton}
                  </div>
                )}
                {isRefusing && (
                  // The refusal has to be visible, not just a cursor shape:
                  // a drop that silently does nothing is indistinguishable
                  // from a drop that failed. Shown even on a collapsed group,
                  // where there are no rows to carry the message otherwise.
                  <p
                    role="status"
                    className="mx-1 mb-1 rounded-md bg-muted px-2 py-1 text-[10px] leading-snug text-muted-foreground"
                  >
                    {t("nav.fileList.reorderWrongGroup")}
                  </p>
                )}
                {isReceiving && (
                  <p
                    role="status"
                    className="mx-1 mb-1 rounded-md bg-muted px-2 py-1 text-[10px] leading-snug text-muted-foreground"
                  >
                    {t("nav.fileList.dropIntoCorpus", { group: displayLabel })}
                  </p>
                )}
                {!isCollapsed && (
                  <GroupFileRows
                    sortable={rowSortable}
                    label={group.label}
                    fileIds={group.files.map((file) => file.id)}
                  >
                    {group.files.map((file, position) => {
                      const canExpand = fileHasSections(file)
                        || (file.id === activeFileId && hasActiveChapters === true)
                      const isExpanded = canExpand && expanded.has(file.id)
                      const isEditing = editingFileId === file.id
                      // Not while renaming: the row holds a text input, and a
                      // drag ancestor takes the pointer away from selecting inside it.
                      const isDraggable = rowSortable && !isEditing
                      return (
                        <FileListRow
                          key={file.id}
                          sortable={rowSortable}
                          id={file.id}
                          group={group.label}
                          draggable={isDraggable}
                          acceptsFileTransfer={acceptsTransfer}
                          handleLabel={isDraggable
                            ? t(
                              canReorderGroup ? "nav.fileList.reorderHandle" : "nav.fileList.moveHandle",
                              { name: file.name },
                            )
                            : null}
                        >
                          <div
                            onPointerEnter={() => prefetchFileProgress(projectId, file.id, getTokenForFile)}
                            onFocusCapture={() => prefetchFileProgress(projectId, file.id, getTokenForFile)}
                          >
                          <FileRow
                            file={file}
                            active={file.id === activeFileId}
                            expanded={isExpanded}
                            expandable={canExpand}
                            progress={fileProgress.get(file.id)}
                            unassigned={dimUnassigned && !assigned.has(file.id)}
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
                            onSegmentation={onSegmentation ? () => onSegmentation(file.id) : undefined}
                            onDelete={onDelete ? () => onDelete(file.id) : undefined}
                            onDownloadOriginal={
                              canExportByOrgPolicy && originalSourceIds.has(file.id)
                                ? () => { void downloadImportedOriginal({
                                    projectId,
                                    file,
                                    getToken: getTokenForFile,
                                  }) }
                                : undefined
                            }
                            onApplySuggestion={
                              onApplySuggestion ? () => onApplySuggestion(file.id) : undefined
                            }
                            reorder={canReorderGroup ? {
                              onUp: () => submit(planFileNudge(group.files, file.id, -1)),
                              onDown: () => submit(planFileNudge(group.files, file.id, 1)),
                              canUp: position > 0,
                              canDown: position < group.files.length - 1,
                            } : undefined}
                          />
                          {isExpanded && (
                            <FileSectionGrid
                              projectId={projectId}
                              fileId={file.id}
                              validationCount={validationCount}
                              countStructural={countStructural}
                              getTokenForFile={getTokenForFile}
                              getChapters={file.id === activeFileId ? getActiveChapterHealth : undefined}
                              deferFetch={deferSectionProgress}
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
                        </FileListRow>
                      )
                    })}
                  </GroupFileRows>
                )}
              </CorpusGroupFrame>
            )
          })}
        </div>
        </FileReorderDnd>
      </div>
      {/* AQU-1569: clearing a group's hand-placed order is shared and cannot be
          undone from here, so it asks first. */}
      <AlertDialog
        open={resetGroup !== null}
        onOpenChange={(open) => { if (!open) setResetGroup(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("nav.fileList.resetOrderTitle", { group: resetGroup?.displayLabel ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("nav.fileList.resetOrderDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const pending = resetGroup
                setResetGroup(null)
                if (pending) submit(pending.writes)
              }}
            >
              {t("nav.fileList.resetOrderConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )

}
