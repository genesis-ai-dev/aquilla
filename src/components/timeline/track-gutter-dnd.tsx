// Pointer reordering for timeline tracks, via dnd-kit. The whole row is the
// handle. The row keeps its own height and moves with the pointer; nothing is
// swapped for a preview, and no drop line is drawn. A drop still writes one
// sort key through `orderForDrop` / `orderForInsert`.

import { useEffect, useLayoutEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react"
import {
  closestCenter,
  DndContext,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type Active,
  type Collision,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DroppableContainer,
  type Modifier,
  type Over,
} from "@dnd-kit/core"
import {
  SortableContext,
  hasSortableData,
  useSortable,
  verticalListSortingStrategy,
  type SortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { cn } from "@/lib/utils"
import { folderIdsOf, trackScope, type TrackRow } from "@/lib/timeline/track-groups"
import { orderForDrop, orderForInsert } from "@/lib/timeline/track-reorder"
import type { TimelineTrack } from "@/lib/timeline/tracks"

/** Sortable group for tracks that are not inside a folder. Not a track id. */
export const TIMELINE_ROOT_GROUP = "timeline:root"

/** Movement before a press becomes a drag, so a click still selects the track. */
export const TRACK_DRAG_ACTIVATION_DISTANCE = 8

export type TrackPointerDrop =
  | { kind: "move"; trackId: string; group: string; toPosition: number }
  | { kind: "regroup"; trackId: string; fromGroup: string; group: string; toPosition: number | null }
  | { kind: "cancel" }

export type TrackReorderCommit =
  | { kind: "reorder"; trackId: string; order: number }
  | { kind: "move"; trackId: string; groupId: string | null; order: number }

/** What a lane copies while its name moves, so the two columns stay in step. */
export type TrackLaneShift = {
  y: number
  hidden: boolean
  transition?: string
  /** The row has left its place, so a later y of 0 is the return trip and must keep its transform. */
  hold?: boolean
}

const rowSlide = { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" }
const rowSlideCss = `transform ${rowSlide.duration}ms ${rowSlide.easing}`

const accessibility = {
  screenReaderInstructions: { draggable: "" },
  announcements: {
    onDragStart: () => "",
    onDragOver: () => "",
    onDragEnd: () => "",
    onDragCancel: () => "",
  },
}

/** Other lists do not slide when the pointer is over a track they do not contain. */
export const trackSortingStrategy: SortingStrategy = (args) => {
  if (args.overIndex < 0 || args.activeIndex < 0) return null
  return verticalListSortingStrategy(args)
}

const lockVertical: Modifier = ({ transform }) => ({ ...transform, x: 0 })

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

function readGroup(data: unknown): string | null {
  if (typeof data !== "object" || data === null || !("group" in data)) return null
  const group = data.group
  return typeof group === "string" ? group : null
}

function hitContainer(hit: Collision): DroppableContainer | undefined {
  const data = hit.data
  if (typeof data !== "object" || data === null || !("droppableContainer" in data)) return undefined
  const container = data.droppableContainer
  if (typeof container !== "object" || container === null || !("id" in container)) return undefined
  return container as DroppableContainer
}

/**
 * The pointer wins when it is on a row. A folder's sortable wraps its members,
 * so both contain the pointer; the smaller one is the member, and that is the
 * slot. Off a row, the nearest track is the slot.
 */
export const trackCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args)
  const rows = hits.filter((hit) => {
    const container = hitContainer(hit)
    return container !== undefined && hasSortableData(container)
  })
  if (rows.length > 0) {
    const area = (hit: Collision) => {
      const container = hitContainer(hit)
      const rect = container ? args.droppableRects.get(container.id) : undefined
      return rect ? rect.width * rect.height : Number.POSITIVE_INFINITY
    }
    return [...rows].sort((a, b) => area(a) - area(b)).slice(0, 1)
  }
  const sortables = args.droppableContainers.filter((container) => hasSortableData(container))
  if (sortables.length === 0) return []
  return closestCenter({ ...args, droppableContainers: sortables }).slice(0, 1)
}

/** What a drop means. `toPosition` is the hovered row's index in that group. */
export function resolveTrackDrop(active: Active | null, over: Over | null): TrackPointerDrop {
  if (!active) return { kind: "cancel" }
  const activeGroup = readGroup(active.data.current)
  if (activeGroup === null) return { kind: "cancel" }
  if (!over) return { kind: "cancel" }
  const overGroup = readGroup(over.data.current)
  if (overGroup === null) return { kind: "cancel" }
  if (overGroup !== activeGroup) {
    return {
      kind: "regroup",
      trackId: String(active.id),
      fromGroup: activeGroup,
      group: overGroup,
      toPosition: hasSortableData(over) ? over.data.current.sortable.index : null,
    }
  }
  if (!hasSortableData(over) || over.id === active.id) return { kind: "cancel" }
  const toPosition = over.data.current.sortable.index
  if (toPosition < 0) return { kind: "cancel" }
  return { kind: "move", trackId: String(active.id), group: activeGroup, toPosition }
}

function tracksInGroup(rows: readonly TrackRow[], group: string): TimelineTrack[] {
  if (group === TIMELINE_ROOT_GROUP) return rows.filter((row) => row.depth === 0).map((row) => row.track)
  const folder = rows.find((row) => row.track.id === group && row.track.kind === "folder")
  return folder ? [...folder.members] : []
}

/**
 * The lower half of a folder's last member means "after it". A hovered row is
 * otherwise the slot before that row, and a folder has no empty band under
 * its last member that could mean the end.
 */
export function adjustTrackDrop(
  rows: readonly TrackRow[],
  resolution: TrackPointerDrop,
  pointer: { y: number; overTop: number; overHeight: number } | null,
): TrackPointerDrop {
  if (resolution.kind !== "regroup" || resolution.toPosition == null || pointer == null) return resolution
  const list = tracksInGroup(rows, resolution.group)
  if (list.length === 0 || resolution.toPosition !== list.length - 1) return resolution
  if (pointer.y <= pointer.overTop + pointer.overHeight / 2) return resolution
  return { ...resolution, toPosition: list.length }
}

export function commitTrackReorder(
  rows: readonly TrackRow[],
  resolution: TrackPointerDrop,
  allowCrossing: boolean,
): TrackReorderCommit | null {
  if (resolution.kind === "cancel") return null
  const moved = rows.map((row) => row.track).find((track) => track.id === resolution.trackId)
    ?? rows.flatMap((row) => [...row.members]).find((track) => track.id === resolution.trackId)
  if (!moved) return null

  if (resolution.kind === "regroup") {
    if (!allowCrossing || moved.kind === "folder") return null
    const groupId = resolution.group === TIMELINE_ROOT_GROUP ? null : resolution.group
    const folderIds = folderIdsOf(rows.map((row) => row.track))
    if (trackScope(moved, folderIds) === groupId) return null
    const target = tracksInGroup(rows, resolution.group).filter((track) => track.id !== moved.id)
    const index = resolution.toPosition ?? target.length
    const placed = orderForInsert(target, index)
    if (!placed) return null
    return { kind: "move", trackId: moved.id, groupId, order: placed.order }
  }

  const list = tracksInGroup(rows, resolution.group)
  const fromIndex = list.findIndex((track) => track.id === resolution.trackId)
  const drop = orderForDrop(list, fromIndex, resolution.toPosition)
  if (!drop) return null
  return { kind: "reorder", trackId: drop.trackId, order: drop.order }
}

/** True when the track has a sibling, or a folder it may enter or leave. */
export function canDragTrack(row: TrackRow, rows: readonly TrackRow[], allowCrossing: boolean): boolean {
  const folderIds = folderIdsOf(rows.map((item) => item.track))
  const scope = trackScope(row.track, folderIds)
  const siblings = rows.filter((item) => trackScope(item.track, folderIds) === scope).length
  if (siblings > 1) return true
  if (!allowCrossing || row.track.kind === "folder") return false
  if (scope !== null) return true
  return rows.some((item) => item.track.kind === "folder")
}

function dragStartsHere(target: EventTarget | null): boolean {
  return !(target instanceof Element && target.closest("button, input, textarea, a"))
}

/**
 * One sortable track, or a folder and the members drawn inside it. The node
 * is the whole block, so a folder moves at the height of everything it shows.
 * The block itself is the handle.
 */
export function SortableTrackBlock({
  sortable,
  id,
  group,
  draggable,
  onShift,
  children,
}: {
  sortable: boolean
  id: string
  group: string
  draggable: boolean
  onShift?: (id: string, shift: TrackLaneShift | null) => void
  children: ReactNode
}) {
  if (!sortable) return children
  return (
    <ActiveTrackSlot id={id} group={group} draggable={draggable} onShift={onShift}>
      {children}
    </ActiveTrackSlot>
  )
}

function ActiveTrackSlot({
  id,
  group,
  draggable,
  onShift,
  children,
}: {
  id: string
  group: string
  draggable: boolean
  onShift?: (id: string, shift: TrackLaneShift | null) => void
  children: ReactNode
}) {
  const data = useMemo(() => ({ group }), [group])
  const { setNodeRef, setActivatorNodeRef, listeners, transform, isDragging } = useSortable({
    id,
    data,
    transition: prefersReducedMotion() ? { duration: 0, easing: "linear" } : rowSlide,
    disabled: draggable ? false : { draggable: true, droppable: false },
  })
  const onShiftRef = useRef(onShift)
  onShiftRef.current = onShift
  // A row that has slid keeps a transform when it comes back to 0. Dropping
  // the property (or reporting no shift) removes it between frames, so the
  // way down eases and the way back snaps.
  const displaced = useRef(false)
  const y = transform?.y ?? 0
  const sorting = transform != null
  const slide = prefersReducedMotion() ? "transform 0ms linear" : rowSlideCss
  useLayoutEffect(() => {
    const report = onShiftRef.current
    if (!report) return
    if (!sorting) {
      displaced.current = false
      report(id, null)
      return
    }
    if (y !== 0) displaced.current = true
    // y 0 before any slide only arms the curve. After a slide, y 0 is the
    // return and has to keep the transform so it eases instead of snapping.
    report(id, {
      y,
      hidden: false,
      transition: isDragging ? undefined : slide,
      hold: displaced.current,
    })
  }, [id, y, sorting, isDragging, slide])
  useLayoutEffect(() => () => onShiftRef.current?.(id, null), [id])
  return (
    <div
      ref={(node) => {
        setNodeRef(node)
        setActivatorNodeRef(node)
      }}
      role="none"
      data-reorderable="true"
      style={{
        transform: sorting ? (CSS.Translate.toString(transform) ?? "translate3d(0px, 0px, 0)") : undefined,
        transition: isDragging || !sorting ? undefined : slide,
        touchAction: draggable ? "none" : undefined,
      }}
      className={cn("relative", draggable && "cursor-grab", isDragging && "z-20 cursor-grabbing")}
      {...listeners}
      onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
        if (!draggable || !dragStartsHere(event.target)) return
        listeners?.onPointerDown?.(event)
        event.stopPropagation()
      }}
    >
      {children}
    </div>
  )
}

export function TrackSortableList({
  id,
  items,
  children,
}: {
  id: string
  items: string[]
  children: ReactNode
}) {
  return (
    <SortableContext id={`timeline-sort:${id}`} items={items} strategy={trackSortingStrategy}>
      {children}
    </SortableContext>
  )
}

export function TrackReorderDnd({
  enabled,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDragCancel,
  children,
}: {
  enabled: boolean
  onDragStart: (event: DragStartEvent) => void
  onDragOver?: (event: DragOverEvent) => void
  onDragEnd: (event: DragEndEvent) => void
  onDragCancel: () => void
  children: ReactNode
}) {
  if (!enabled) return children
  return (
    <ActiveTrackReorder
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      {children}
    </ActiveTrackReorder>
  )
}

function ActiveTrackReorder({
  onDragStart,
  onDragOver,
  onDragEnd,
  onDragCancel,
  children,
}: {
  onDragStart: (event: DragStartEvent) => void
  onDragOver?: (event: DragOverEvent) => void
  onDragEnd: (event: DragEndEvent) => void
  onDragCancel: () => void
  children: ReactNode
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: TRACK_DRAG_ACTIVATION_DISTANCE } }),
  )
  useEffect(() => {
    return () => {
      document.body.style.cursor = ""
    }
  }, [])
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={trackCollision}
      modifiers={[lockVertical]}
      accessibility={accessibility}
      onDragStart={(event) => {
        document.body.style.cursor = "grabbing"
        onDragStart(event)
      }}
      onDragOver={onDragOver}
      onDragEnd={(event) => {
        document.body.style.cursor = ""
        onDragEnd(event)
      }}
      onDragCancel={() => {
        document.body.style.cursor = ""
        onDragCancel()
      }}
    >
      {children}
    </DndContext>
  )
}
