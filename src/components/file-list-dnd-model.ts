// AQU-1647: which slot a file-sidebar drop landed on. The numbers written for
// that slot still come from `planFileMove`; this module never computes them.

import {
  pointerWithin,
  type Active,
  type Collision,
  type CollisionDetection,
  type DroppableContainer,
  type Over,
} from "@dnd-kit/core"
import { hasSortableData } from "@dnd-kit/sortable"

/** Pointer movement (px) before a press becomes a drag, so a click still opens the file. */
export const FILE_DRAG_ACTIVATION_DISTANCE = 8

export type SidebarFileDrop =
  | { kind: "move"; fileId: string; group: string; toPosition: number }
  | { kind: "refuse"; group: string }
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
  // A file only moves inside the group it already belongs to. The other
  // group's header and its rows are both refusals, including a collapsed
  // group that has no row under the pointer.
  if (overGroup !== activeGroup) return { kind: "refuse", group: overGroup }
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

/**
 * A file row sits inside its group droppable. Prefer the row: dropping on a
 * row takes that row's slot, while the group itself only exists so a hover
 * in the header (or in another group) can be refused instead of falling
 * through to whichever row is nearest.
 */
export const sidebarFileCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args)
  const fileHits = hits.filter((hit) => {
    const container = containerOf(hit)
    return container !== undefined && hasSortableData(container)
  })
  return fileHits.length > 0 ? fileHits : hits
}
