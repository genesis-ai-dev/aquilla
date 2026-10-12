// AQU-1647: which slot a file-sidebar drop landed on. The numbers written for
// that slot still come from `planFileMove`; this module never computes them.

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

/** Pointer movement (px) before a press becomes a drag, so a click still opens the file. */
export const FILE_DRAG_ACTIVATION_DISTANCE = 8

export type SidebarFileDrop =
  /** Within the file's own group: a new slot. */
  | { kind: "move"; fileId: string; group: string; toPosition: number }
  /**
   * AQU-1702: into a DIFFERENT group. `toPosition` is the slot in that
   * group, or null when the pointer was on the group rather than one of its
   * rows (its header, or a collapsed group) — meaning the end. Whether the
   * move can actually be written is `planFileRegroup`'s call, not geometry's.
   */
  | { kind: "regroup"; fileId: string; fromGroup: string; group: string; toPosition: number | null }
  | { kind: "cancel" }

export function readSidebarGroup(data: unknown): string | null {
  if (typeof data !== "object" || data === null || !("group" in data)) return null
  const group = data.group
  return typeof group === "string" ? group : null
}

/**
 * What a drop means. `toPosition` is the hovered row's index in the group's
 * current visual order — the same index `planFileMove` already expects from
 * the native drag path this replaced.
 */
export function resolveSidebarFileDrop(active: Active | null, over: Over | null): SidebarFileDrop {
  if (!active) return { kind: "cancel" }
  const activeGroup = readSidebarGroup(active.data.current)
  if (activeGroup === null) return { kind: "cancel" }
  if (!over) return { kind: "cancel" }
  const overGroup = readSidebarGroup(over.data.current)
  if (overGroup === null) return { kind: "cancel" }
  // AQU-1702: another group is a move into it, at the hovered row's slot —
  // or at its end when the pointer is on the group itself (its header, or a
  // collapsed group with no row under the pointer).
  if (overGroup !== activeGroup) {
    return {
      kind: "regroup",
      fileId: String(active.id),
      fromGroup: activeGroup,
      group: overGroup,
      toPosition: hasSortableData(over) ? over.data.current.sortable.index : null,
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
 * The pointer wins when it is actually on a row, in any group (AQU-1702: a
 * row in another group is the slot the file lands in there). A different
 * group's header, or a collapsed one, targets that group as a whole — the
 * file lands at its end. Gaps between rows, and a pointer that
 * has drifted off the narrow column, keep sorting against the nearest row in
 * the active group — otherwise the list freezes the moment the cursor leaves
 * a 28px row. The active group's own header is the exception: it is above
 * every row, and hovering it should not preview a move.
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
    return groupHits.filter((hit) => {
      const container = containerOf(hit)
      return container !== undefined && readSidebarGroup(container.data.current) === hoveredGroupName
    })
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
