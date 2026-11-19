import { memo, useCallback, useLayoutEffect, useRef } from "react"
import { FileRow, type FileRowProps } from "./FileRow"
import type { FileStats } from "@/lib/progress/file-summary-progress"

/**
 * A sidebar file row that re-renders only when what it SHOWS changes
 * (AQU-2654).
 *
 * The file list hands every row about fifteen callbacks, and builds them in
 * its own render from props the workspace builds in ITS render — so every
 * render of the workspace re-rendered every file row: two menu roots, three
 * tooltips, the progress bars, about 75 components a file. On a 20-file
 * project that was 1,500 components per workspace commit, and it grows with
 * the project: a whole Bible is 66 files.
 *
 * `FileRowSlot` takes exactly FileRow's props. It re-renders with the list
 * (one cheap component) to keep a ref to the latest callbacks, and renders a
 * memoized row whose props are only the data: the file, its flags, its
 * progress, and WHICH actions exist. The row's handlers read the ref when the
 * user acts, so they are never stale — and never a reason to re-render.
 */
export function FileRowSlot(props: FileRowProps) {
  const latest = useRef(props)
  useLayoutEffect(() => {
    latest.current = props
  })
  const getLatest = useCallback(() => latest.current, [])
  return (
    <StableFileRow
      getLatest={getLatest}
      file={props.file}
      active={props.active}
      expanded={props.expanded}
      expandable={props.expandable}
      progress={props.progress}
      openCommentCount={props.openCommentCount}
      hasSuggestion={props.hasSuggestion}
      editing={props.editing}
      unassigned={props.unassigned}
      hasShowDetails={props.onShowDetails !== undefined}
      hasExport={props.onExport !== undefined}
      hasDownloadOriginal={props.onDownloadOriginal !== undefined}
      hasAssignWork={props.onAssignWork !== undefined}
      hasSegmentation={props.onSegmentation !== undefined}
      hasReimport={props.onReimport !== undefined}
      hasUploadRecordings={props.onUploadRecordings !== undefined}
      hasDelete={props.onDelete !== undefined}
      hasApplySuggestion={props.onApplySuggestion !== undefined}
      canReorder={props.reorder !== undefined}
      canUp={props.reorder?.canUp ?? false}
      canDown={props.reorder?.canDown ?? false}
    />
  )
}

/** The data half of FileRowProps, plus which optional actions the row offers. */
interface StableFileRowProps
  extends Pick<
    FileRowProps,
    | "file" | "active" | "expanded" | "expandable" | "progress" | "openCommentCount"
    | "hasSuggestion" | "editing" | "unassigned"
  > {
  getLatest: () => FileRowProps
  hasShowDetails: boolean
  hasExport: boolean
  hasDownloadOriginal: boolean
  hasAssignWork: boolean
  hasSegmentation: boolean
  hasReimport: boolean
  hasUploadRecordings: boolean
  hasDelete: boolean
  hasApplySuggestion: boolean
  canReorder: boolean
  canUp: boolean
  canDown: boolean
}

const StableFileRow = memo(function StableFileRow({
  getLatest,
  hasShowDetails, hasExport, hasDownloadOriginal, hasAssignWork, hasSegmentation,
  hasReimport, hasUploadRecordings, hasDelete, hasApplySuggestion,
  canReorder, canUp, canDown,
  ...data
}: StableFileRowProps) {
  return (
    <FileRow
      {...data}
      onEditCommit={(name) => getLatest().onEditCommit(name)}
      onEditCancel={() => getLatest().onEditCancel()}
      onToggleExpand={() => getLatest().onToggleExpand()}
      onSelect={() => getLatest().onSelect()}
      onStartRename={() => getLatest().onStartRename()}
      onMove={() => getLatest().onMove()}
      onShowDetails={hasShowDetails ? () => getLatest().onShowDetails?.() : undefined}
      onExport={hasExport ? () => getLatest().onExport?.() : undefined}
      onDownloadOriginal={hasDownloadOriginal ? () => getLatest().onDownloadOriginal?.() : undefined}
      onAssignWork={hasAssignWork ? () => getLatest().onAssignWork?.() : undefined}
      onSegmentation={hasSegmentation ? () => getLatest().onSegmentation?.() : undefined}
      onReimport={hasReimport ? () => getLatest().onReimport?.() : undefined}
      onUploadRecordings={hasUploadRecordings ? () => getLatest().onUploadRecordings?.() : undefined}
      onDelete={hasDelete ? () => getLatest().onDelete?.() : undefined}
      onApplySuggestion={hasApplySuggestion ? () => getLatest().onApplySuggestion?.() : undefined}
      reorder={
        canReorder
          ? {
              onUp: () => getLatest().reorder?.onUp(),
              onDown: () => getLatest().reorder?.onDown(),
              canUp,
              canDown,
            }
          : undefined
      }
    />
  )
}, sameRow)

/**
 * Shallow, except `progress`: the list is handed a fresh stats object for the
 * same figures whenever the progress map is rebuilt, so it is compared by its
 * figures.
 */
function sameRow(prev: StableFileRowProps, next: StableFileRowProps): boolean {
  for (const key of Object.keys(next) as Array<keyof StableFileRowProps>) {
    if (key === "progress") continue
    if (prev[key] !== next[key]) return false
  }
  return sameStats(prev.progress, next.progress)
}

function sameStats(a: FileStats | undefined, b: FileStats | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof FileStats>
  for (const key of keys) {
    if (a[key] !== b[key]) return false
  }
  return true
}
