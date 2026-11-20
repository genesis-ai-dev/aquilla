// Pointer reordering for timeline tracks, via dnd-kit. The whole row is the
// handle. The row keeps its own height and moves with the pointer; nothing is
// swapped for a preview, and no drop line is drawn. A drop still writes one
// sort key through `orderForDrop` / `orderForInsert`.

import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent, type ReactNode } from "react"
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
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DroppableContainer,
  type Modifier,
  type Over,
  type PointerSensorProps,
} from "@dnd-kit/core"
import {
  SortableContext,
  defaultAnimateLayoutChanges,
  hasSortableData,
  useSortable,
  verticalListSortingStrategy,
  type SortingStrategy,
} from "@dnd-kit/sortable"
import { cn } from "@/lib/utils"
import { folderIdsOf, trackScope, type TrackRow } from "@/lib/timeline/track-groups"
import { orderForDrop, orderForInsert } from "@/lib/timeline/track-reorder"
import type { TimelineTrack } from "@/lib/timeline/tracks"
import { dragSlopPx } from "@/lib/timeline/drag-slop"

/** Sortable group for tracks that are not inside a folder. Not a track id. */
export const TIMELINE_ROOT_GROUP = "timeline:root"

/** A mouse's movement before a press becomes a drag, so a click still selects
 *  the track. A finger or a pen needs the app's touch distance (AQU-2491). */
export const TRACK_DRAG_ACTIVATION_DISTANCE = 8

/** dnd-kit's pointer sensor, with its activation distance read off the
 *  pointer that pressed (`dragSlopPx`). */
class TrackPointerSensor extends PointerSensor {
  constructor(props: PointerSensorProps) {
    const pointerType = "pointerType" in props.event ? (props.event as PointerEvent).pointerType : undefined
    super({ ...props, options: { ...props.options, activationConstraint: { distance: dragSlopPx(pointerType, TRACK_DRAG_ACTIVATION_DISTANCE) } } })
  }
}

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
  /** The row is in the air, drawn over the rows it crosses. */
  lift?: boolean
}

const rowSlide = { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" }
const rowSlideCss = `transform ${rowSlide.duration}ms ${rowSlide.easing}`
/** A short neighbour shift stays on the shared curve. A row let go far from
 *  its slot needs longer, or the trip home still reads as a snap. */
const ROW_RETURN_MAX_MS = 340
/** How long a same-list drop takes to settle, at most. Painting the new order
 *  is a render, and a render mid-glide swallows its frames, so the order is
 *  painted once the row has landed. Until then the rows stay parked where the
 *  drop left them, which is where the new order puts them anyway. */
export const TRACK_RELEASE_SETTLE_MS = ROW_RETURN_MAX_MS + 40
/** How long the track list must sit untouched before a painted order is saved.
 *  Saving re-renders the whole workspace for most of a second, which stalls a
 *  drag that starts inside it, so the save waits until the user has stopped
 *  arranging tracks — or does anything else first. */
export const TRACK_ORDER_SAVE_QUIET_MS = 5000
/** A track dropped into or out of a folder stays where the pointer left it
 *  until the new scope paints. The write is a round trip, so this outlives
 *  the short reorder glide, then lets go if the scope never changes. */
const SCOPE_DROP_HOLD_MS = 1200

function translate3d(x: number, y: number): string {
  return `translate3d(${x ? Math.round(x) : 0}px, ${y ? Math.round(y) : 0}px, 0)`
}

function measureLayoutTop(node: HTMLElement): number {
  const transform = node.style.transform
  const transition = node.style.transition
  node.style.transform = "none"
  node.style.transition = "none"
  const top = node.getBoundingClientRect().top
  node.style.transform = transform
  node.style.transition = transition
  return top
}

/** Where a row just mounted by a scope drop will rest. Its folder block's
 *  gap slide is easing closed in the same frame, so a rect still reads the
 *  block where the slide had it — a row away from where the row lands. */
function measureRestingTop(node: HTMLElement): number {
  const block = node.parentElement?.closest<HTMLElement>("[data-reorderable]")
  if (!block) return measureLayoutTop(node)
  const transform = block.style.transform
  const transition = block.style.transition
  block.style.transform = "none"
  block.style.transition = "none"
  const top = measureLayoutTop(node)
  block.style.transform = transform
  block.style.transition = transition
  return top
}

/** A row's trip of this length, on the release curve. */
export function trackSlideMotion(distancePx: number): { duration: number; easing: string } {
  const duration = Math.round(Math.min(ROW_RETURN_MAX_MS, Math.max(rowSlide.duration, distancePx * 0.45)))
  return { duration, easing: rowSlide.easing }
}

function returnMotion(distancePx: number): { transition: string; duration: number } {
  const { duration, easing } = trackSlideMotion(distancePx)
  return { transition: `transform ${duration}ms ${easing}`, duration }
}

type RowRelease = {
  from: { x: number; y: number }
  toY: number
  phase: "hold" | "glide"
  /** The row that was in the air, so it stays above the ones it crosses. */
  lift: boolean
  /**
   * A swap parks the row in the gap until the new order paints. A let-go
   * outside the list clears itself when the glide home finishes.
   */
  pin: boolean
  /** A scope change. The pin holds the row on the pointer, and the timer
   *  still clears it so a refused write cannot leave the row translated. */
  dropHold?: boolean
  orderKey: string
  transition: string
  duration: number
}

/** Where a drop inside the list should leave the dragged row, in the same
 *  translate the pointer was using. Matches the sortable strategy's slot. */
type TrackReleasePlan = {
  id: number
  /** `hold` parks the dragged row on the pointer. Its destination is a
   *  different list, so the same-list slot would throw it across the folder. */
  mode: "home" | "slot" | "hold"
  activeId: string
  slotY: number
  /** A scope drop's dragged row, at the moment of release, in viewport
   *  coordinates. The row REMOUNTS when its new scope paints — a member
   *  leaves its folder's block, a root track enters it — so no state on the
   *  old node survives to animate the landing. This top is the only witness
   *  the new node gets: it starts where the pointer left the row and glides
   *  to wherever it now lives. */
  fromVisualTop?: number
  /** When the drop happened. A row mounted after the hold is over (a folder
   *  opened again, a file revisited) is not this drop's landing. */
  at?: number
  /** The new node has landed. The plan outlives it in the ref, and a later
   *  mount of the same track replaying the landing is the snap this stops. */
  landed?: boolean
}

/** `true` is a reorder in the same list. `"scope"` crossed a folder wall. */
export type TrackDragFinish = boolean | "scope"

const TrackReleasePlanContext = createContext<MutableRefObject<TrackReleasePlan | null> | null>(null)
/** The track column's extent, as the collision last measured it. */
const TrackColumnBoundsContext = createContext<MutableRefObject<{ top: number; bottom: number } | null> | null>(null)

function sortableIndex(data: unknown): number | null {
  if (typeof data !== "object" || data === null || !("sortable" in data)) return null
  const sortable = data.sortable
  if (typeof sortable !== "object" || sortable === null || !("index" in sortable)) return null
  return typeof sortable.index === "number" ? sortable.index : null
}

function alignedSlotY(event: DragEndEvent): number {
  const activeRect = event.active.rect.current?.initial
  const over = event.over
  if (!activeRect || !over) return 0
  const activeIndex = sortableIndex(event.active.data.current)
  const overIndex = sortableIndex(over.data.current)
  if (activeIndex == null || overIndex == null || activeIndex === overIndex) return 0
  if (activeIndex < overIndex) {
    return over.rect.top + over.rect.height - (activeRect.top + activeRect.height)
  }
  return over.rect.top - activeRect.top
}

export function releasePlanFor(
  event: DragEndEvent,
  committed: TrackDragFinish,
  bounds: { top: number; bottom: number } | null,
): TrackReleasePlan {
  const home: TrackReleasePlan = { id: 0, mode: "home", activeId: String(event.active.id), slotY: 0 }
  if (committed === "scope") {
    const initialTop = event.active.rect.current.initial?.top
    return {
      id: 0, mode: "hold", activeId: String(event.active.id), slotY: event.delta.y,
      fromVisualTop: initialTop == null ? undefined : initialTop + event.delta.y,
    }
  }
  if (!committed || !bounds || !event.over || event.over.id === event.active.id) return home
  const start = event.activatorEvent
  if (!(start instanceof MouseEvent)) return home
  const y = start.clientY + event.delta.y
  // Above the first row or below the last one is a let-go outside the list.
  // Between rows, the pointer is still in the list.
  if (y < bounds.top || y > bounds.bottom) return home
  return { id: 0, mode: "slot", activeId: String(event.active.id), slotY: alignedSlotY(event) }
}

/**
 * The lane beside a sliding name. A transform here is a stacking context, so
 * it exists only while the row is away from its place or easing back. A folder
 * member adds its folder's shift: the gutter nests the member inside the
 * folder's transform, and the lanes are siblings, so they have to add it.
 */
export function laneShiftCss(
  trackId: string,
  groupId: string | null | undefined,
  shifts: ReadonlyMap<string, TrackLaneShift>,
): { transform: string; transition: string } | null {
  const own = shifts.get(trackId)
  const parent = groupId ? shifts.get(groupId) : undefined
  if (!own && !parent) return null
  const y = (own?.y ?? 0) + (parent?.y ?? 0)
  // A row reporting its own shift owns the curve. The dragged row reports
  // none, and borrowing its folder's slide made its lane trail the pointer.
  const transition = own ? (own.transition ?? "") : (parent?.transition ?? "")
  if (y === 0 && !own?.hold && !parent?.hold) {
    return transition ? { transform: "", transition } : null
  }
  return { transform: `translateY(${y}px)`, transition }
}

/** Write one lane's shift. Reads the inline style, so it does not reflow. */
export function paintLaneNode(node: HTMLElement, shifts: ReadonlyMap<string, TrackLaneShift>): void {
  const id = node.getAttribute("data-tl-track-lane")
  if (!id) return
  const css = laneShiftCss(id, node.getAttribute("data-tl-lane-group"), shifts)
  const transform = css?.transform ?? ""
  const transition = css?.transition ?? ""
  if (node.style.transform !== transform) node.style.transform = transform
  if (node.style.transition !== transition) node.style.transition = transition
  const lifted = shifts.get(id)?.lift === true
  if (node.hasAttribute("data-tl-lifted") !== lifted) node.toggleAttribute("data-tl-lifted", lifted)
}

/** Every mounted copy of the lanes. A time column mounts its own set. */
export function paintLaneShifts(root: ParentNode, shifts: ReadonlyMap<string, TrackLaneShift>): void {
  for (const node of root.querySelectorAll<HTMLElement>("[data-tl-track-lane]")) {
    paintLaneNode(node, shifts)
  }
}

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

/** The row stops at the column's top edge, however far above it the pointer goes. */
function stopAtColumnTop(bounds: MutableRefObject<{ top: number; bottom: number } | null>): Modifier {
  return ({ transform, activeNodeRect }) => {
    const top = bounds.current?.top
    if (top == null || !activeNodeRect) return transform
    return { ...transform, y: Math.max(transform.y, top - activeNodeRect.top) }
  }
}

export function prefersReducedMotion(): boolean {
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
 *
 * A folder only lands among the top-level rows. Over an open folder's member
 * it read as going into that folder, which a folder cannot, so the drop was
 * refused and the folder snapped back.
 */
export const trackCollision: CollisionDetection = (args) => {
  const activeId = String(args.active.id)
  const draggingFolder = args.droppableContainers.some((container) => readGroup(container.data.current) === activeId)
  if (!draggingFolder) return collideTracks(args)
  return collideTracks({
    ...args,
    droppableContainers: args.droppableContainers.filter((container) => readGroup(container.data.current) === TIMELINE_ROOT_GROUP),
  })
}

const collideTracks: CollisionDetection = (args) => {
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
  // Above the column the row has stopped at the top while the pointer goes
  // on, so the nearest centre to the row is a row under the top: a folder's
  // first member, which shuffled down inside a folder the drag was leaving.
  // Above the column is the top of the column.
  const pointer = args.pointerCoordinates
  if (pointer) {
    let first: DroppableContainer | null = null
    let firstTop = Number.POSITIVE_INFINITY
    for (const container of sortables) {
      if (readGroup(container.data.current) !== TIMELINE_ROOT_GROUP) continue
      const rect = args.droppableRects.get(container.id)
      if (rect && rect.top < firstTop) {
        first = container
        firstTop = rect.top
      }
    }
    if (first && pointer.y < firstTop) return [{ id: first.id, data: { droppableContainer: first, value: 0 } }]
  }
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
 * The order for a track crossing into `target` at `index`, read off the rows
 * drawn, unsaved orders included. A tie with a neighbour goes to the end of
 * the scope instead: one write to a free slot rather than renumbering it.
 * The parent cannot judge the tie: its orders are behind the rows' until the
 * held drops save.
 */
function orderEnteringScope(target: readonly TimelineTrack[], index: number): number | null {
  const placed = orderForInsert(target, index)
  if (!placed) return null
  if (!placed.needsRenormalise) return placed.order
  const orders = target.map((track) => track.order).filter(Number.isFinite)
  return orders.length > 0 ? Math.max(...orders) + 1 : 0
}

/**
 * Which side of the hovered row a cross-folder drop means, by its midpoint:
 * the upper half is the slot before that row, the lower half the slot after
 * it. Without this, aiming between two folder members while dragging in from
 * outside only worked by hovering the NEXT member — the lower half of a
 * member could not mean "between me and the next one", and the folder's end
 * (the lower half of its last member) could not be aimed at at all, there
 * being no next member to hover. The same rule serves a member dragged out
 * onto the rows above or below its folder.
 */
export function adjustTrackDrop(
  rows: readonly TrackRow[],
  resolution: TrackPointerDrop,
  pointer: { y: number; overTop: number; overHeight: number; activeHeight?: number } | null,
): TrackPointerDrop {
  if (resolution.kind === "move" && pointer != null) {
    return aboveOpenFolder(rows, resolution, pointer.y, pointer.overTop, pointer.activeHeight ?? 0)
  }
  if (resolution.kind !== "regroup" || resolution.toPosition == null || pointer == null) return resolution
  const list = tracksInGroup(rows, resolution.group)
  if (list.length === 0 || resolution.toPosition < 0 || resolution.toPosition >= list.length) return resolution
  // Past the folder's last member ENTIRELY — the pointer is in the empty
  // space under the folder, and the member is only the nearest target the
  // collision could find. That is not "the end of the folder", it is "below
  // the folder, at the top level": a track dragged down through a folder
  // must be able to come out the other side in the same drag, without first
  // being dropped in and dragged back out. (Where a root row follows the
  // folder this never triggers — the pointer is over that row instead.)
  if (resolution.group !== TIMELINE_ROOT_GROUP && pointer.y > pointer.overTop + pointer.overHeight) {
    const over = list[resolution.toPosition]
    const isLastMember = resolution.toPosition === list.length - 1
    if (over && isLastMember) {
      const root = tracksInGroup(rows, TIMELINE_ROOT_GROUP)
      const folderIndex = root.findIndex((track) => track.id === resolution.group)
      if (folderIndex >= 0) {
        // The insertion index counts the root list WITHOUT the dragged
        // track, which is the list both the commit and the gap read.
        const movedIndex = root.findIndex((track) => track.id === resolution.trackId)
        const folderAt = movedIndex >= 0 && movedIndex < folderIndex ? folderIndex - 1 : folderIndex
        return { ...resolution, group: TIMELINE_ROOT_GROUP, toPosition: folderAt + 1 }
      }
    }
  }
  if (pointer.y <= pointer.overTop + pointer.overHeight / 2) return resolution
  return { ...resolution, toPosition: resolution.toPosition + 1 }
}

/**
 * Above an open folder is the root slot before it, not its heading. The
 * collision measures the folder where it lies, but a track dragged up onto
 * it has slid it down by the track's height to open that slot: the pointer
 * reads "on the heading" while the row is drawn above the folder. Above the
 * column, the folder is the target too, the pointer over nothing at all.
 */
function aboveOpenFolder(
  rows: readonly TrackRow[],
  drop: Extract<TrackPointerDrop, { kind: "move" }>,
  pointerY: number,
  overTop: number,
  activeHeight: number,
): TrackPointerDrop {
  if (drop.group !== TIMELINE_ROOT_GROUP) return drop
  const root = tracksInGroup(rows, TIMELINE_ROOT_GROUP)
  const over = root[drop.toPosition]
  if (!over || over.kind !== "folder" || over.id === drop.trackId) return drop
  const folder = rows.find((row) => row.track.id === over.id)
  if (!folder || folder.collapsed || folder.members.length === 0) return drop
  const movedIndex = root.findIndex((track) => track.id === drop.trackId)
  // A folder never goes into a folder, so over a heading it is already a reorder.
  if (root[movedIndex]?.kind === "folder") return drop
  const drawnTop = movedIndex > drop.toPosition ? overTop + activeHeight : overTop
  if (!(pointerY < drawnTop)) return drop
  const folderAt = movedIndex >= 0 && movedIndex < drop.toPosition ? drop.toPosition - 1 : drop.toPosition
  return { kind: "regroup", trackId: drop.trackId, fromGroup: TIMELINE_ROOT_GROUP, group: TIMELINE_ROOT_GROUP, toPosition: folderAt }
}

export function commitTrackReorder(
  rows: readonly TrackRow[],
  drop: TrackPointerDrop,
  allowCrossing: boolean,
): TrackReorderCommit | null {
  if (drop.kind === "cancel") return null
  const moved = rows.map((row) => row.track).find((track) => track.id === drop.trackId)
    ?? rows.flatMap((row) => [...row.members]).find((track) => track.id === drop.trackId)
  if (!moved) return null

  // An open folder's heading is the way in, at the top. A closed one is just
  // a row you can sit above — entering it is a rest on an empty folder, not
  // this drop. A folder does not go inside a folder. With track editing off
  // a heading stays a reorder beside it.
  let resolution = drop
  if (
    allowCrossing &&
    resolution.kind === "move" &&
    resolution.group === TIMELINE_ROOT_GROUP &&
    moved.kind !== "folder"
  ) {
    const over = tracksInGroup(rows, TIMELINE_ROOT_GROUP)[resolution.toPosition]
    if (over?.kind === "folder") {
      const folder = rows.find((row) => row.track.id === over.id)
      if (folder && !folder.collapsed && folder.members.length > 0) {
        resolution = {
          kind: "regroup",
          trackId: moved.id,
          fromGroup: TIMELINE_ROOT_GROUP,
          group: over.id,
          toPosition: 0,
        }
      }
    }
  }

  if (resolution.kind === "regroup") {
    if (!allowCrossing || moved.kind === "folder") return null
    const groupId = resolution.group === TIMELINE_ROOT_GROUP ? null : resolution.group
    const folderIds = folderIdsOf(rows.map((row) => row.track))
    const target = tracksInGroup(rows, resolution.group).filter((track) => track.id !== moved.id)
    const index = resolution.toPosition ?? target.length
    const placed = orderForInsert(target, index)
    if (!placed) return null
    // Same scope after all: a drop adjusted to "below the folder" for a
    // track that was never in it (`adjustTrackDrop`). That is a reorder
    // within its own list, not a scope move — writing `groupId` for it
    // would need the gate a plain reorder does not.
    if (trackScope(moved, folderIds) === groupId) {
      return placed.order === moved.order
        ? null
        : { kind: "reorder", trackId: moved.id, order: placed.order }
    }
    const order = orderEnteringScope(target, index)
    return order == null ? null : { kind: "move", trackId: moved.id, groupId, order }
  }

  const list = tracksInGroup(rows, resolution.group)
  const fromIndex = list.findIndex((track) => track.id === resolution.trackId)
  const placed = orderForDrop(list, fromIndex, resolution.toPosition)
  if (!placed) return null
  return { kind: "reorder", trackId: placed.trackId, order: placed.order }
}

/**
 * Whether a gap already open at the head of the column should stay open
 * while the pointer rides above the column. Above the last row's rect the
 * collision layer stops reporting a useful target — it hands back the
 * dragged row itself, or nothing, or a heading hit — and each of those
 * answers would clear or re-aim a top gap that a release at that height
 * still honours. Only the same track's top-level, first-boundary gap is
 * retained, and only while the pointer is strictly above where the
 * column starts.
 */
export function shouldRetainTopDragGap(
  current: (Pick<TrackDragGap, "groupId" | "boundary"> & { trackId: string }) | null,
  trackId: string,
  pointerY: number | null,
  columnTop: number | null,
): boolean {
  return current?.trackId === trackId
    && current.groupId == null
    && current.boundary === 0
    && pointerY != null
    && columnTop != null
    && pointerY < columnTop
}

export interface TrackDragGap {
  /** The folder the dragged track would land in, or null for the top level. */
  groupId: string | null
  /** Insertion boundary in the rendered rows WITHOUT the dragged row. */
  boundary: number
  /**
   * How far each OTHER rendered row must slide, in flattened row space, to
   * open the gap the dragged row would land in. Only rows that move appear.
   * A folder member's entry is its absolute slide: the gutter nests members
   * inside their folder's block, so the caller subtracts the block's own
   * slide before painting a member (the lane side adds it back — see
   * `laneShiftCss`).
   */
  shifts: ReadonlyMap<string, number>
}

/**
 * The gap a cross-folder drag should open while it is still in the air.
 *
 * dnd-kit's sortable strategy only slides rows inside the dragged row's own
 * list, so a drag that crosses a folder wall — into a folder, or a member
 * dragged out past its heading — slides NOTHING: the folder's members stand
 * still, and a member lifted above its folder slides up underneath the
 * folder's opaque band with no room made for it anywhere. This computes the
 * missing slides in the one space both cases share, the flattened rendered
 * rows: lift the dragged row out, insert a gap of its height at the drop
 * boundary, and every row between its old place and the gap trades places
 * with it. Rows beyond the gap do not move — the vacancy and the gap cancel.
 *
 * Returns null for a drop the sortable already previews (a reorder inside
 * one list), for a folder being dragged (folders never cross), and for a
 * drop that would not change the dragged track's folder. The drop it reads
 * is the same adjusted resolution `onTrackDragEnd` commits, so the gap the
 * user sees is the landing the release performs.
 */
export function dragGapForDrop(
  rows: readonly TrackRow[],
  drop: TrackPointerDrop,
  activeHeightPx: number,
): TrackDragGap | null {
  if (drop.kind === "cancel" || !Number.isFinite(activeHeightPx) || activeHeightPx <= 0) return null
  const moved = rows.map((row) => row.track).find((track) => track.id === drop.trackId)
    ?? rows.flatMap((row) => [...row.members]).find((track) => track.id === drop.trackId)
  if (!moved || moved.kind === "folder") return null
  const folderIds = folderIdsOf(rows.map((row) => row.track))
  const originScope = trackScope(moved, folderIds)

  // The same heading rule the commit applies: an open, non-empty folder's
  // heading is the way in at the top. (An empty or closed heading is not —
  // entering an empty folder is the dwell preview's business, and it has no
  // members to make room among anyway.)
  let groupId: string | null
  let toPosition: number
  if (drop.kind === "regroup") {
    groupId = drop.group === TIMELINE_ROOT_GROUP ? null : drop.group
    const target = tracksInGroup(rows, drop.group).filter((track) => track.id !== moved.id)
    toPosition = drop.toPosition ?? target.length
  } else {
    if (drop.group !== TIMELINE_ROOT_GROUP) return null
    const over = tracksInGroup(rows, TIMELINE_ROOT_GROUP)[drop.toPosition]
    if (!over || over.kind !== "folder") return null
    const folder = rows.find((row) => row.track.id === over.id)
    if (!folder || folder.collapsed || folder.members.length === 0) return null
    groupId = over.id
    toPosition = 0
  }
  if (groupId === originScope) return null

  const fromRowIndex = rows.findIndex((row) => row.track.id === moved.id)
  if (fromRowIndex < 0) return null
  const remaining = rows.filter((_, index) => index !== fromRowIndex)

  // The boundary in flattened remaining space. A folder's members are
  // contiguous under their heading, so a position inside a folder is the
  // heading's slot plus the member offset; a top-level position lands just
  // before that top-level row, or past the last row at the end.
  let boundary: number
  if (groupId != null) {
    const heading = remaining.findIndex((row) => row.track.id === groupId)
    if (heading < 0) return null
    let members = 0
    while (remaining[heading + 1 + members]?.depth === 1) members += 1
    boundary = heading + 1 + Math.max(0, Math.min(toPosition, members))
  } else {
    boundary = remaining.length
    let seen = 0
    for (let i = 0; i < remaining.length; i += 1) {
      if (remaining[i].depth !== 0) continue
      if (seen === toPosition) { boundary = i; break }
      seen += 1
    }
  }

  const shifts = new Map<string, number>()
  remaining.forEach((row, restIndex) => {
    const beforeOrigin = restIndex < fromRowIndex
    const dy = beforeOrigin
      ? (restIndex >= boundary ? activeHeightPx : 0)
      : (restIndex >= boundary ? 0 : -activeHeightPx)
    if (dy !== 0) shifts.set(row.track.id, dy)
  })
  return { groupId, boundary, shifts }
}

/** How long a member sits anywhere under its folder before it steps out. */
export const FOLDER_EXIT_DWELL_MS = 1200

/** How long a track rests on an empty folder before it previews going in. */
export const FOLDER_ENTER_DWELL_MS = 1000

/**
 * A pointer above a closed folder is a reorder into the slot above it.
 * The folder row is the nearest target, and treating that as an enter is
 * what makes the track fall in when the drag was aimed above the heading.
 */
export function orderAboveClosedFolder(
  rows: readonly TrackRow[],
  drop: TrackPointerDrop,
  pointerY: number,
  folderTop: number,
): { trackId: string; order: number } | null {
  if (drop.kind !== "move" || drop.group !== TIMELINE_ROOT_GROUP) return null
  if (!(pointerY < folderTop)) return null
  const over = tracksInGroup(rows, TIMELINE_ROOT_GROUP)[drop.toPosition]
  if (!over || over.kind !== "folder" || over.id === drop.trackId) return null
  const folder = rows.find((row) => row.track.id === over.id)
  if (!folder?.collapsed) return null
  const order = orderBesideFolder(rows, over.id, "above")
  if (order == null) return null
  return { trackId: drop.trackId, order }
}

/**
 * Above a folder the track leaves at once. Anywhere under it — the rest of
 * the track column included — is the pause. Inside the block it stays put.
 */
export function folderDragEdge(top: number, bottom: number, pointerY: number): "above" | "below" | null {
  if (pointerY < top) return "above"
  if (pointerY > bottom) return "below"
  return null
}

/** The root order that puts a track immediately above or below this folder. */
export function orderBesideFolder(
  rows: readonly TrackRow[],
  folderId: string,
  edge: "above" | "below",
): number | null {
  const root = tracksInGroup(rows, TIMELINE_ROOT_GROUP)
  const index = root.findIndex((track) => track.id === folderId)
  if (index < 0) return null
  return orderEnteringScope(root, edge === "above" ? index : index + 1)
}

/** The root order that puts a track immediately after this folder. */
export function orderToLeaveFolder(rows: readonly TrackRow[], folderId: string): number | null {
  return orderBesideFolder(rows, folderId, "below")
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
  shiftY,
  counterShiftY,
  children,
}: {
  sortable: boolean
  id: string
  group: string
  draggable: boolean
  onShift?: (id: string, shift: TrackLaneShift | null) => void
  /** Cross-folder gap slide for this row (see `dragGapForDrop`), relative to
   *  the block it is painted inside. Ignored while this row itself is dragged. */
  shiftY?: number
  /** The enclosing folder block's own gap slide. A dragged member rides
   *  inside that block, so the block's slide is subtracted from the pointer
   *  delta or the row would be carried away from the pointer by it. */
  counterShiftY?: number
  children: ReactNode
}) {
  if (!sortable) return children
  return (
    <ActiveTrackSlot id={id} group={group} draggable={draggable} onShift={onShift} shiftY={shiftY} counterShiftY={counterShiftY}>
      {children}
    </ActiveTrackSlot>
  )
}

function ActiveTrackSlot({
  id,
  group,
  draggable,
  onShift,
  shiftY = 0,
  counterShiftY = 0,
  children,
}: {
  id: string
  group: string
  draggable: boolean
  onShift?: (id: string, shift: TrackLaneShift | null) => void
  shiftY?: number
  counterShiftY?: number
  children: ReactNode
}) {
  const data = useMemo(() => ({ group }), [group])
  // A gap slide that has just closed keeps its transform (at 0) and its
  // transition for one slide's duration. Dropping both the moment the slide
  // reaches 0 — which is what an unshifted row paints — made the way back
  // snap while the way out eased: dragging down past a folder member, the
  // member (or the folder itself) jumped up instead of gliding.
  const [gapHold, setGapHold] = useState(false)
  const gapShown = shiftY !== 0 || gapHold
  const { setNodeRef, setActivatorNodeRef, listeners, transform, isDragging, items, active } = useSortable({
    id,
    data,
    transition: prefersReducedMotion() ? { duration: 0, easing: "linear" } : rowSlide,
    disabled: draggable ? false : { draggable: true, droppable: false },
    // The sortable animates a moved row from its old rect, which it measures
    // without this row's transform. A row showing a gap is already drawn at
    // its new place, so that animation would throw it back by the gap and
    // slide it down a second time.
    animateLayoutChanges: (args) => !gapShown && defaultAnimateLayoutChanges(args),
  })
  const onShiftRef = useRef(onShift)
  onShiftRef.current = onShift
  const nodeRef = useRef<HTMLDivElement | null>(null)
  // A row that has slid keeps a transform when it comes back to 0. Dropping
  // the property (or reporting no shift) removes it between frames, so the
  // way down eases and the way back snaps.
  const displaced = useRef(false)
  // Once a folder member's pointer leaves that member's list, the sortable
  // drops its delta and the row snaps home. The last delta plus the pointer's
  // further travel is the same movement a drag inside the list already uses.
  const dragLock = useRef<{ pointerY: number; transformY: number } | null>(null)
  const pointerY = useRef<number | null>(null)
  const transformY = useRef<number | null>(null)
  transformY.current = transform?.y ?? null
  const [, followPointer] = useState(0)
  useEffect(() => {
    if (!isDragging) {
      dragLock.current = null
      pointerY.current = null
      return
    }
    const move = (event: PointerEvent) => {
      pointerY.current = event.clientY
      // The sortable stops reporting once the pointer leaves this row's list,
      // so the rest of the travel has to paint from the pointer itself.
      if (transformY.current == null && dragLock.current) followPointer((n) => n + 1)
    }
    document.addEventListener("pointermove", move)
    return () => document.removeEventListener("pointermove", move)
  }, [isDragging])
  if (isDragging && transform && pointerY.current != null) {
    dragLock.current = { pointerY: pointerY.current, transformY: transform.y }
  }
  // The carried travel has no modifiers on it, so it stops at the column's
  // top here, as the sortable's own delta does. A member above its folder
  // went off the top of the column while a top-level track stopped there.
  const columnBounds = useContext(TrackColumnBoundsContext)
  const carriedFree = transform == null && isDragging && dragLock.current && pointerY.current != null
    ? dragLock.current.transformY + (pointerY.current - dragLock.current.pointerY)
    : null
  const columnTop = columnBounds?.current?.top
  const startTop = active?.rect.current.initial?.top
  const carried = carriedFree != null && columnTop != null && startTop != null
    ? Math.max(carriedFree, columnTop - startTop)
    : carriedFree
  const rawY = transform?.y ?? carried ?? 0
  // The pointer delta, less the enclosing folder block's gap slide: the block
  // carries this row with it, and without the subtraction a member whose
  // folder just slid down to make room above itself would jump down with it,
  // away from the pointer that caused the slide.
  const y = isDragging ? rawY - counterShiftY : rawY
  // A cross-folder gap slide, painted only on a row at rest in its own list:
  // while the sortable is displacing this row (a same-list drag) its own
  // transform already says where it goes, and the gap is never set then.
  const gapY = !isDragging && transform == null ? shiftY : 0
  useEffect(() => {
    if (shiftY !== 0) { setGapHold(true); return }
    if (!gapHold) return
    const timer = window.setTimeout(() => setGapHold(false), rowSlide.duration + 40)
    return () => window.clearTimeout(timer)
  }, [shiftY, gapHold])
  const planRef = useContext(TrackReleasePlanContext)
  const landedPlan = useRef(0)
  useLayoutEffect(() => {
    // A drop that crossed a folder wall paints its new scope in the same
    // commit, and that layout is the one the gap was previewing: the row is
    // already drawn there. Easing the gap closed on top of the moved layout
    // would throw it a gap away and slide it back, so the gap simply goes.
    if (shiftY !== 0 || !gapHold || active != null) return
    const plan = planRef?.current
    if (plan?.mode !== "hold" || landedPlan.current === plan.id) return
    landedPlan.current = plan.id
    setGapHold(false)
  }, [shiftY, gapHold, active, planRef])
  const sorting = isDragging || transform != null
  // The gesture ends by deleting the transform. Holding the release offset
  // for one frame, then easing it to 0, is what makes a row let go far from
  // its slot travel home instead of popping.
  const lastTransform = useRef<{ x: number; y: number } | null>(null)
  const lastVisualTop = useRef<number | null>(null)
  const restTop = useRef<number | null>(null)
  const wasSorting = useRef(false)
  // The pointer left this row's list mid-drag, and the sortable dropped the
  // slide it had made room with. The folder block starts sliding in the same
  // commit, so a member that snapped home jumped a row and rode back down
  // with the block. Easing it home on the same curve keeps it where it is.
  const leftList = !sorting && active != null && wasSorting.current
  const gapPainted = !isDragging && transform == null && (gapY !== 0 || gapHold || leftList)
  const slide = prefersReducedMotion() ? "transform 0ms linear" : rowSlideCss
  const lifting = useRef(false)
  const seenDrop = useRef(0)
  const [release, setRelease] = useState<RowRelease | null>(null)
  const orderKey = items.join("\0")
  if (isDragging) lifting.current = true
  if (sorting && (transform || carried != null)) lastTransform.current = { x: transform?.x ?? 0, y }
  useLayoutEffect(() => {
    if (release?.pin && release.orderKey !== orderKey) setRelease(null)
  }, [orderKey, release])
  useLayoutEffect(() => {
    const node = nodeRef.current
    if (sorting) {
      if (node) {
        lastVisualTop.current = node.getBoundingClientRect().top
        if (!wasSorting.current) restTop.current = measureLayoutTop(node)
      }
      wasSorting.current = true
      if (isDragging) setRelease((current) => (current ? null : current))
      return
    }
    if (!wasSorting.current) {
      // A scope drop's row, freshly mounted in its new list: the node the
      // pointer was carrying is gone, and this one was born at the
      // destination, which reads as a teleport. Start it where the pointer
      // left it and glide it home — the FLIP the same-list release does
      // with its own surviving node, rebuilt from the plan's one witness.
      const plan = planRef?.current
      if (
        node && plan?.mode === "hold" && plan.activeId === id
        && plan.fromVisualTop != null && seenDrop.current !== plan.id
        && !plan.landed && performance.now() - (plan.at ?? 0) < SCOPE_DROP_HOLD_MS
        && !prefersReducedMotion()
      ) {
        seenDrop.current = plan.id
        if (planRef) planRef.current = { ...plan, landed: true }
        const layoutTop = measureRestingTop(node)
        restTop.current = layoutTop
        const fromY = plan.fromVisualTop - layoutTop
        if (Math.abs(fromY) >= 0.5) {
          const motion = returnMotion(Math.abs(fromY))
          setRelease({
            from: { x: 0, y: fromY }, toY: 0, phase: "hold", lift: true, pin: false, orderKey,
            transition: motion.transition, duration: motion.duration,
          })
          return
        }
      }
      if (!release && node) restTop.current = node.getBoundingClientRect().top
      return
    }
    if (active != null) {
      // The pointer left this row's list, and the drag goes on. The row is
      // still in it: the rest it measured at the start holds, so coming back
      // in must not measure again. Measuring strips the transform, and on a
      // row a gap is holding up that restarts the slide from nothing — the
      // row drops a whole row and climbs back. What it had painted is gone.
      lastTransform.current = null
      return
    }
    const plan = planRef?.current
    if (!plan || seenDrop.current === plan.id) {
      wasSorting.current = false
      return
    }
    seenDrop.current = plan.id
    wasSorting.current = false
    const from = lastTransform.current
    lastTransform.current = null
    const lift = lifting.current
    lifting.current = false
    if (!from || prefersReducedMotion()) return
    if (plan.mode === "hold" && plan.activeId === id) {
      if (Math.abs(from.x) < 0.5 && Math.abs(from.y) < 0.5) return
      setRelease({
        from, toY: from.y, phase: "hold", lift: true, pin: true, dropHold: true, orderKey,
        transition: "transform 0ms linear", duration: SCOPE_DROP_HOLD_MS,
      })
      return
    }
    const layoutTop = node ? measureLayoutTop(node) : undefined
    const layoutMoved = layoutTop != null && restTop.current != null && Math.abs(layoutTop - restTop.current) > 1
    // The visual top the drag ended at is the layout top plus the transform
    // VALUE — never a rect measured while sorting. A neighbour's slide is a
    // CSS transition that interpolates between React renders, so a rect
    // caught mid-slide is stale by up to the whole slide; releasing on it
    // replayed a slide the neighbour had already finished (the row snapped
    // back to its old slot, then glided the full row height a second time).
    // The transform value is the state the drag actually reached, and the
    // release may only animate from there to the new layout: between
    // states, and nothing more.
    const visualTop = restTop.current != null ? restTop.current + from.y : lastVisualTop.current
    const residual = visualTop != null && layoutTop != null
      ? visualTop - layoutTop
      : from.y
    const settling = plan.mode === "slot"
    if (settling && plan.activeId === id) {
      // If the new order is already painted, the leftover is against that
      // slot. Otherwise park in the gap and only close the off-center gap.
      const toY = layoutMoved ? 0 : plan.slotY
      const fromY = layoutMoved ? residual : from.y
      const motion = returnMotion(Math.abs(fromY - toY))
      setRelease({
        from: { x: from.x, y: fromY }, toY, phase: "hold", lift: true,
        pin: !layoutMoved, orderKey,
        transition: motion.transition, duration: motion.duration,
      })
      return
    }
    if (settling) {
      if (layoutMoved) {
        if (Math.abs(residual) < 0.5) return
        const motion = returnMotion(Math.abs(residual))
        setRelease({
          from: { x: 0, y: residual }, toY: 0, phase: "hold", lift: false,
          pin: false, orderKey, transition: motion.transition, duration: motion.duration,
        })
        return
      }
      if (Math.abs(from.y) < 0.5 && Math.abs(from.x) < 0.5) return
      // Neighbours already sit in the gap. Keep them there until the order paints.
      setRelease({
        from, toY: from.y, phase: "hold", lift: false, pin: true, orderKey,
        transition: slide, duration: rowSlide.duration,
      })
      return
    }
    // Home is the new slot when the drop's order painted with the release.
    const homeY = layoutMoved ? residual : from.y
    if (Math.abs(from.x) < 0.5 && Math.abs(homeY) < 0.5) return
    const motion = returnMotion(Math.hypot(from.x, homeY))
    setRelease({
      from: { x: from.x, y: homeY }, toY: 0, phase: "hold", lift, pin: false, orderKey,
      transition: motion.transition, duration: motion.duration,
    })
  }, [sorting, isDragging, transform, id, orderKey, planRef, slide, release, active])
  useLayoutEffect(() => {
    if (release?.phase !== "hold") return
    const frame = requestAnimationFrame(() => {
      // A CSS transition starts from the last style the browser RESOLVED,
      // not the last one written. A drop arrives on a pointer event, so this
      // frame callback runs before the hold pose is ever painted; without a
      // read here the glide starts from whatever was resolved last — the
      // transform-less measurement pass — and the row stalls, then snaps
      // instead of settling. Reading layout resolves the hold (the lanes'
      // too: they are painted with it) as the glide's starting point.
      nodeRef.current?.getBoundingClientRect()
      setRelease((current) => (current?.phase === "hold" ? { ...current, phase: "glide" } : current))
    })
    return () => cancelAnimationFrame(frame)
  }, [release])
  useEffect(() => {
    if (release?.phase !== "glide") return
    const node = nodeRef.current
    const finish = () => setRelease((current) => {
      if (current?.phase !== "glide") return current
      if (current.pin && !current.dropHold) return current
      return null
    })
    const timer = window.setTimeout(finish, release.duration + 40)
    const onEnd = (event: TransitionEvent) => {
      if (event.target === node && event.propertyName === "transform") finish()
    }
    node?.addEventListener("transitionend", onEnd)
    return () => {
      window.clearTimeout(timer)
      node?.removeEventListener("transitionend", onEnd)
    }
  }, [release])
  useLayoutEffect(() => {
    const report = onShiftRef.current
    if (!report) return
    if (release) {
      report(id, {
        y: release.phase === "hold" ? release.from.y : release.toY,
        hidden: false,
        transition: release.phase === "hold" ? "transform 0ms linear" : release.transition,
        hold: true,
        lift: release.lift,
      })
      return
    }
    if (!sorting) {
      if (gapPainted) {
        // At 0 this is the return trip: the lane keeps the transform and
        // the curve for the same hold duration as the gutter row, or the
        // two columns would arrive home at different speeds.
        report(id, { y: gapY, hidden: false, transition: slide, hold: true })
        return
      }
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
      lift: isDragging,
    })
  }, [id, y, gapY, gapPainted, sorting, isDragging, slide, release])
  useLayoutEffect(() => () => onShiftRef.current?.(id, null), [id])
  const releaseY = release ? (release.phase === "hold" ? release.from.y : release.toY) : 0
  const releaseTransform = release ? translate3d(release.from.x, releaseY) : undefined
  // The folder's slide eases, so the dragged member's counter to it has to
  // ease on the same curve or the row jumps a slide's height off the pointer
  // and drifts back. `translate` transitions on its own; the pointer's share
  // stays on `transform`, which must not.
  const counterTranslate = isDragging && !release ? `0px ${-counterShiftY}px` : undefined
  return (
    <div
      ref={(node) => {
        nodeRef.current = node
        setNodeRef(node)
        setActivatorNodeRef(node)
      }}
      role="none"
      data-reorderable="true"
      style={{
        transform: releaseTransform
          ?? (sorting ? translate3d(transform?.x ?? 0, counterTranslate ? rawY : y) : gapPainted ? translate3d(0, gapY) : undefined),
        translate: counterTranslate,
        transition: release
          ? (release.phase === "hold" ? "transform 0ms linear" : release.transition)
          : isDragging
            ? (prefersReducedMotion() ? undefined : `translate ${rowSlide.duration}ms ${rowSlide.easing}`)
            : (!sorting && !gapPainted ? undefined : slide),
        touchAction: draggable ? "none" : undefined,
      }}
      className={cn(
        "relative",
        // The row is transparent at rest so the gutter rule shows through it.
        // In the air it crosses the name under it, and a solid surface keeps
        // that name from printing through this one. `bg-background` is the
        // surface (white in the light theme), so the label stays readable.
        // Over a folder's heading too: its band is lifted to z-30 to cover the
        // gutter rule, and a row at z-20 slid under any heading standing still.
        (isDragging || release?.lift) && "z-40 bg-background",
        // A member in the air is stacked inside its folder's block, and the
        // block's slide transform traps it there: every heading after the
        // folder painted over it. Raising the block raises the member with it.
        active != null && !isDragging && readGroup(active.data.current) === id && "z-40",
      )}
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
  onDragMove,
  onDragEnd,
  onDragCancel,
  onPaintNow,
  children,
}: {
  enabled: boolean
  onDragStart: (event: DragStartEvent) => void
  onDragOver?: (event: DragOverEvent) => void
  /** Every pointer move mid-drag, not just a change of hovered row: which
   *  side of a folder member the pointer is on can change within one row. */
  onDragMove?: (event: DragMoveEvent) => void
  onDragEnd: (event: DragEndEvent) => TrackDragFinish
  onDragCancel: () => void
  /** A same-list drop with no slot to park in glides straight to its new
   *  place, so the order it wrote has to paint with the release. */
  onPaintNow?: () => void
  children: ReactNode
}) {
  if (!enabled) return children
  return (
    <ActiveTrackReorder
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
      onPaintNow={onPaintNow}
    >
      {children}
    </ActiveTrackReorder>
  )
}

function trackCollisionWithBounds(
  bounds: MutableRefObject<{ top: number; bottom: number } | null>,
): CollisionDetection {
  return (args) => {
    let top = Number.POSITIVE_INFINITY
    let bottom = Number.NEGATIVE_INFINITY
    for (const container of args.droppableContainers) {
      if (!hasSortableData(container)) continue
      const rect = args.droppableRects.get(container.id)
      if (!rect) continue
      top = Math.min(top, rect.top)
      bottom = Math.max(bottom, rect.bottom)
    }
    bounds.current = Number.isFinite(top) && Number.isFinite(bottom) ? { top, bottom } : null
    return trackCollision(args)
  }
}

function ActiveTrackReorder({
  onDragStart,
  onDragOver,
  onDragMove,
  onDragEnd,
  onDragCancel,
  onPaintNow,
  children,
}: {
  onDragStart: (event: DragStartEvent) => void
  onDragOver?: (event: DragOverEvent) => void
  onDragMove?: (event: DragMoveEvent) => void
  onDragEnd: (event: DragEndEvent) => TrackDragFinish
  onDragCancel: () => void
  /** A same-list drop with no slot to park in glides straight to its new
   *  place, so the order it wrote has to paint with the release. */
  onPaintNow?: () => void
  children: ReactNode
}) {
  const sensors = useSensors(
    useSensor(TrackPointerSensor),
  )
  const boundsRef = useRef<{ top: number; bottom: number } | null>(null)
  const planRef = useRef<TrackReleasePlan | null>(null)
  const dropId = useRef(0)
  const collision = useMemo(() => trackCollisionWithBounds(boundsRef), [])
  const modifiers = useMemo(() => [lockVertical, stopAtColumnTop(boundsRef)], [])
  return (
    <TrackReleasePlanContext.Provider value={planRef}>
    <TrackColumnBoundsContext.Provider value={boundsRef}>
      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        modifiers={modifiers}
        accessibility={accessibility}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragMove={onDragMove}
        onDragEnd={(event) => {
          const finish = onDragEnd(event)
          const plan = releasePlanFor(event, finish, boundsRef.current)
          dropId.current += 1
          plan.id = dropId.current
          plan.at = performance.now()
          planRef.current = plan
          if (finish === true && plan.mode === "home") onPaintNow?.()
        }}
        onDragCancel={() => {
          dropId.current += 1
          planRef.current = { id: dropId.current, mode: "home", activeId: "", slotY: 0 }
          onDragCancel()
        }}
      >
        {children}
      </DndContext>
    </TrackColumnBoundsContext.Provider>
    </TrackReleasePlanContext.Provider>
  )
}
