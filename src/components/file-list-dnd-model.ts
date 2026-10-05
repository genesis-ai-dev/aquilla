// AQU-1647: which slot a file-sidebar drop landed on, and the live preview of a
// file crossing into another custom corpus. The numbers written for that slot
// still come from `planFileMove` / `planFileInsert`.

import {
  closestCenter,
  pointerWithin,
  type Active,
  type Collision,
  type CollisionDetection,
  type DroppableContainer,
  type Modifier,
  type Over,
} from "@dnd-kit/core"
import { hasSortableData } from "@dnd-kit/sortable"
import { groupByCorpus, type CorpusGroup, type GroupableFile } from "@/lib/sidebar/group-by-corpus"
import { planFileInsert, type SortIndexWrite } from "@/lib/sidebar/file-sort-index"

/** Pointer movement (px) before a press becomes a drag, so a click still opens the file. */
export const FILE_DRAG_ACTIVATION_DISTANCE = 8

export type SidebarFileDrop =
  | { kind: "move"; fileId: string; group: string; toPosition: number }
  | { kind: "transfer"; fileId: string; fromGroup: string; toGroup: string; toPosition: number }
  | { kind: "refuse"; group: string }
  | { kind: "cancel" }

export function readSidebarGroup(data: unknown): string | null {
  if (typeof data !== "object" || data === null || !("group" in data)) return null
  const group = data.group
  return typeof group === "string" ? group : null
}

/** Set on custom-corpus rows and headers. Testament folders and Ungrouped leave it off. */
export function readAcceptsFileTransfer(data: unknown): boolean {
  return typeof data === "object" && data !== null
    && "acceptsFileTransfer" in data
    && data.acceptsFileTransfer === true
}

/**
 * Where an incoming file lands relative to the hovered row. The top half of
 * the row is that row's slot; the bottom half is the slot after it, which is
 * how a drop on the last row can land at the end of the group.
 *
 * `overIndex` is the hovered row's slot in the group the file is joining,
 * counted without the file itself. The preview list's own sortable index is
 * a different number once the file is already sitting in that list.
 */
export function sidebarInsertionIndex(active: Active, over: Over, overIndex: number): number {
  const translated = active.rect.current.translated
  if (!translated) return overIndex
  const mid = over.rect.top + over.rect.height / 2
  return translated.top > mid ? overIndex + 1 : overIndex
}

/**
 * What a drop means. `toPosition` is the slot the file should occupy
 * afterwards. Inside its own group that slot is what `planFileMove` expects.
 * A custom corpus accepts a file from another custom corpus, and that slot
 * is what `planFileInsert` expects. Old Testament, New Testament, and
 * Ungrouped stay refusals.
 */
export function resolveSidebarFileDrop(active: Active | null, over: Over | null): SidebarFileDrop {
  if (!active) return { kind: "cancel" }
  const activeGroup = readSidebarGroup(active.data.current)
  if (activeGroup === null) return { kind: "cancel" }
  if (!over) return { kind: "cancel" }
  const overGroup = readSidebarGroup(over.data.current)
  if (overGroup === null) return { kind: "cancel" }
  if (overGroup !== activeGroup) {
    const canTransfer = readAcceptsFileTransfer(active.data.current)
      && readAcceptsFileTransfer(over.data.current)
    if (!canTransfer) return { kind: "refuse", group: overGroup }
    // A collapsed group, or the header above its rows, has no row under the
    // pointer. The file joins at the top, where the header sits.
    if (!hasSortableData(over)) {
      return {
        kind: "transfer",
        fileId: String(active.id),
        fromGroup: activeGroup,
        toGroup: overGroup,
        toPosition: 0,
      }
    }
    const overIndex = over.data.current.sortable.index
    if (overIndex < 0) return { kind: "cancel" }
    return {
      kind: "transfer",
      fileId: String(active.id),
      fromGroup: activeGroup,
      toGroup: overGroup,
      toPosition: sidebarInsertionIndex(active, over, overIndex),
    }
  }
  if (!hasSortableData(over) || over.id === active.id) return { kind: "cancel" }
  const toPosition = over.data.current.sortable.index
  if (toPosition < 0) return { kind: "cancel" }
  return { kind: "move", fileId: String(active.id), group: activeGroup, toPosition }
}

function containerOf(hit: Collision): DroppableContainer | undefined {
  const data = hit.data
  if (typeof data !== "object" || data === null || !("droppableContainer" in data)) return undefined
  const container = data.droppableContainer
  if (typeof container !== "object" || container === null || !("id" in container)) return undefined
  return container as DroppableContainer
}

/** The lifted row stays in the sidebar column while the pointer tracks the slot. */
export const lockSidebarDragToVertical: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
})

function sameGroupFiles(args: Parameters<CollisionDetection>[0], group: string): DroppableContainer[] {
  return args.droppableContainers.filter((container) => {
    return hasSortableData(container) && readSidebarGroup(container.data.current) === group
  })
}

/**
 * A file row sits inside its group droppable.
 *
 * The pointer wins when it is actually on a row. A different group's header
 * is a refusal unless that group is a custom corpus, in which case the
 * nearest row in it is the slot the file would move into. Gaps between rows,
 * and a pointer that has drifted off the narrow column, keep sorting against
 * the nearest row in the active group — otherwise the list freezes the
 * moment the cursor leaves a 28px row. The active group's own header is the
 * exception: it is above every row, and hovering it should not preview a move.
 */
export const sidebarFileCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args)
  const fileHits = hits.filter((hit) => {
    const container = containerOf(hit)
    return container !== undefined && hasSortableData(container)
  })
  if (fileHits.length > 0) return fileHits

  const activeGroup = readSidebarGroup(args.active?.data.current)
  const groupHits = hits.filter((hit) => {
    const container = containerOf(hit)
    return container !== undefined && !hasSortableData(container)
  })
  const hoveredGroup = groupHits
    .map((hit) => containerOf(hit))
    .find((container): container is DroppableContainer => container !== undefined)
  const hoveredGroupName = hoveredGroup ? readSidebarGroup(hoveredGroup.data.current) : null

  if (hoveredGroupName !== null && hoveredGroupName !== activeGroup) {
    const foreignHits = groupHits.filter((hit) => {
      const container = containerOf(hit)
      return container !== undefined && readSidebarGroup(container.data.current) === hoveredGroupName
    })
    const accepts = hoveredGroup !== undefined && readAcceptsFileTransfer(hoveredGroup.data.current)
    const rows = accepts ? sameGroupFiles(args, hoveredGroupName) : []
    if (rows.length === 0 || !args.pointerCoordinates) return foreignHits
    const firstTop = rows.reduce((top, container) => {
      const rect = args.droppableRects.get(container.id)
      return rect ? Math.min(top, rect.top) : top
    }, Number.POSITIVE_INFINITY)
    // The header sits above the rows. A pointer there joins the group at the
    // top. A pointer in a gap between rows still targets the nearest row.
    if (args.pointerCoordinates.y < firstTop) return foreignHits
    return closestCenter({ ...args, droppableContainers: rows }).slice(0, 1)
  }

  const rows = activeGroup === null ? [] : sameGroupFiles(args, activeGroup)
  if (
    hoveredGroupName === activeGroup &&
    args.pointerCoordinates &&
    rows.length > 0
  ) {
    const firstTop = rows.reduce((top, container) => {
      const rect = args.droppableRects.get(container.id)
      return rect ? Math.min(top, rect.top) : top
    }, Number.POSITIVE_INFINITY)
    if (args.pointerCoordinates.y < firstTop) return groupHits
  }

  if (rows.length > 0) return closestCenter({ ...args, droppableContainers: rows }).slice(0, 1)
  return groupHits
}

/** The slot a file is being shown in while it is dragged across custom corpuses. */
export interface CorpusTransferPreview {
  fileId: string
  toGroup: string
  toPosition: number
}

type PreviewFile = GroupableFile & { id: string }

/**
 * The file list the sidebar should draw while a drag is carrying a file into
 * another custom corpus. The original list is unchanged — this is a picture
 * of where the gap is, built from the same `planFileInsert` the drop commits.
 * Returns the same array when there is nothing to preview.
 */
export function previewCorpusTransfer<T extends PreviewFile>(
  files: readonly T[],
  preview: CorpusTransferPreview | null,
): readonly T[] {
  if (!preview) return files
  const moving = files.find((file) => file.id === preview.fileId)
  if (!moving) return files
  const target = groupByCorpus([...files]).find((group) => group.label === preview.toGroup)
  const neighbours = (target?.files ?? []).filter((file) => file.id !== preview.fileId)
  const writes = planFileInsert(neighbours, preview.fileId, preview.toPosition)
  return applyTransferWrites(files, preview.fileId, preview.toGroup, writes)
}

/**
 * Groups to render during that preview. A corpus that just gave up its only
 * file stays on screen as an empty header, so the pointer can come back to it.
 */
export function previewSidebarGroups<T extends PreviewFile>(
  files: readonly T[],
  preview: CorpusTransferPreview | null,
  sourceGroup: string | null,
): CorpusGroup<T>[] {
  const original = groupByCorpus([...files])
  if (!preview) return original
  const display = groupByCorpus([...previewCorpusTransfer(files, preview)])
  if (!sourceGroup || display.some((group) => group.label === sourceGroup)) return display
  const source = original.find((group) => group.label === sourceGroup)
  if (!source) return display
  const index = original.findIndex((group) => group.label === sourceGroup)
  const next = display.slice()
  next.splice(Math.min(Math.max(index, 0), next.length), 0, { ...source, files: [] })
  return next
}

function applyTransferWrites<T extends PreviewFile>(
  files: readonly T[],
  fileId: string,
  toGroup: string,
  writes: readonly SortIndexWrite[],
): readonly T[] {
  const sortById = new Map(writes.map((write) => [write.fileId, write.sortIndex]))
  let changed = false
  const next = files.map((file) => {
    const moving = file.id === fileId
    const written = sortById.has(file.id)
    if (!moving && !written) return file
    const sortIndex = written ? sortById.get(file.id) : file.sortIndex
    const corpusMarker = moving ? toGroup : file.corpusMarker
    const cleared = sortIndex === null || sortIndex === undefined
    if (file.corpusMarker === corpusMarker && (cleared ? file.sortIndex === undefined : file.sortIndex === sortIndex)) {
      return file
    }
    changed = true
    if (cleared) {
      const { sortIndex: _dropped, ...rest } = file
      return { ...rest, corpusMarker } as T
    }
    return { ...file, corpusMarker, sortIndex }
  })
  return changed ? next : files
}

export type CorpusPreviewAction = "set" | "clear" | "keep"

/**
 * Whether the live gap should follow this hover. The frames have a gap between
 * them, and a pointer in that gap can still be reported as the nearest row.
 * The gap stays where it is until the pointer is actually inside the corpus
 * it would be leaving or joining.
 */
export function corpusPreviewAction(
  kind: "transfer" | "move" | "refuse" | "cancel",
  pointerY: number | null,
  groupRect: { top: number; bottom: number } | null,
  overRect: { top: number; bottom: number } | null,
): CorpusPreviewAction {
  const inside = (rect: { top: number; bottom: number } | null) =>
    pointerY !== null && rect !== null && pointerY >= rect.top && pointerY <= rect.bottom
  if (kind === "refuse") return "clear"
  if (kind === "cancel") return inside(groupRect) ? "clear" : "keep"
  if (kind === "transfer") {
    if (pointerY === null || inside(groupRect) || inside(overRect)) return "set"
    return "keep"
  }
  if (pointerY === null || inside(groupRect) || inside(overRect)) return "clear"
  return "keep"
}
