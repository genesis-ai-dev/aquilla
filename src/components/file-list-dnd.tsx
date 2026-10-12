// AQU-1647: pointer dragging for the editor file sidebar.
//
// Which slot a drop landed on lives in `file-list-dnd-model`; the numbers
// written for that slot still come from `planFileMove` / `planFileInsert`.
// AQU-1702 made a drop on another group a move INTO it, so the frame marks
// itself as the drop target and the row under the pointer shows the slot;
// "Move to corpus…" remains the non-drag path. Keyboard reordering stays on
// Move up / Move down; there is no keyboard sensor, and the library's
// space-bar instructions are cleared so a screen reader is not told about a
// gesture this list does not offer.
//
// The grip is the only thing that starts a drag. The row itself stays a
// click (and the sidebar stays a scroll). The lifted row is a copy that
// tracks the pointer; the source becomes the gap the other rows slide into.

import { useEffect, useMemo, type PointerEvent, type ReactNode } from "react"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  type SortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { GripVertical } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  FILE_DRAG_ACTIVATION_DISTANCE,
  lockSidebarDragToVertical,
  sidebarFileCollision,
} from "./file-list-dnd-model"

const pointerSensorOptions = {
  activationConstraint: { distance: FILE_DRAG_ACTIVATION_DISTANCE },
}

// The library's default announcements name internal ids, and its default
// instructions tell the user to press space. Neither matches this list.
const accessibility = {
  screenReaderInstructions: { draggable: "" },
  announcements: {
    onDragStart: () => "",
    onDragOver: () => "",
    onDragEnd: () => "",
    onDragCancel: () => "",
  },
}

// Two cases the library's own math cannot express for this list:
//
//   * `overIndex < 0` — the pointer is over another group, so nothing in THIS
//     group moves.
//   * `activeIndex < 0` (AQU-1702) — the dragged file belongs to another
//     group, so it is not in this context's items. The library would shift the
//     rows above the pointer upwards, as if the active row had left a gap
//     here. It did not: the newcomer is arriving. The insertion line marks the
//     slot instead of a shift that lies about which rows are moving.
const sidebarSortingStrategy: SortingStrategy = (args) => {
  if (args.overIndex < 0 || args.activeIndex < 0) return null
  return verticalListSortingStrategy(args)
}

const rowSlide = { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" }

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

export function FileDragPreview({ name }: { name: string }) {
  return (
    <div aria-hidden className="flex h-full min-h-7 items-start">
      <div className="flex h-7 w-full items-center gap-1 rounded-lg bg-popover px-2 text-[13px] text-popover-foreground shadow-lg ring-1 ring-border">
        <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{name}</span>
      </div>
    </div>
  )
}

export function FileReorderDnd({
  enabled,
  overlay,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDragCancel,
  children,
}: {
  enabled: boolean
  overlay: ReactNode
  onDragStart: (event: DragStartEvent) => void
  onDragOver: (event: DragOverEvent) => void
  onDragEnd: (event: DragEndEvent) => void
  onDragCancel: () => void
  children: ReactNode
}) {
  if (!enabled) return children
  return (
    <ActiveFileReorder
      overlay={overlay}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      {children}
    </ActiveFileReorder>
  )
}

function ActiveFileReorder({
  overlay,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDragCancel,
  children,
}: {
  overlay: ReactNode
  onDragStart: (event: DragStartEvent) => void
  onDragOver: (event: DragOverEvent) => void
  onDragEnd: (event: DragEndEvent) => void
  onDragCancel: () => void
  children: ReactNode
}) {
  const sensors = useSensors(useSensor(PointerSensor, pointerSensorOptions))
  useEffect(() => {
    return () => {
      document.body.style.cursor = ""
    }
  }, [])
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={sidebarFileCollision}
      modifiers={[lockSidebarDragToVertical]}
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
      {/* No drop flight: the list itself moves into the slot on release.
          Animating the overlay toward the pre-move rect would land it somewhere
          else and then throw it away. */}
      <DragOverlay dropAnimation={null} style={{ pointerEvents: "none" }}>
        {overlay}
      </DragOverlay>
    </DndContext>
  )
}

/**
 * AQU-1702: how the group reads while a file is held over it. `target` is the
 * group the file will join on release; `refused` is a drop this group cannot
 * accept (see `planFileRegroup`) and is paired with the message the list
 * renders inside the frame.
 */
export type GroupDropState = "target" | "refused" | null

const groupDropClass: Record<"target" | "refused", string> = {
  target: "rounded-xl ring-1 ring-primary/60 bg-primary/5",
  refused: "rounded-xl ring-1 ring-border bg-muted/40",
}

export function CorpusGroupFrame({
  droppable,
  label,
  dropState,
  groupRef,
  children,
}: {
  droppable: boolean
  label: string
  dropState?: GroupDropState
  groupRef: (element: HTMLDivElement | null) => void
  children: ReactNode
}) {
  const className = cn("transition-colors", dropState && groupDropClass[dropState])
  if (!droppable) return <div ref={groupRef} className={className}>{children}</div>
  return (
    <DroppableCorpusGroup label={label} className={className} groupRef={groupRef}>
      {children}
    </DroppableCorpusGroup>
  )
}

export function GroupFileRows({
  sortable,
  label,
  fileIds,
  children,
}: {
  sortable: boolean
  label: string
  fileIds: string[]
  children: ReactNode
}) {
  if (!sortable) return <div className="space-y-0.5">{children}</div>
  return (
    <SidebarSortableGroup label={label} fileIds={fileIds}>
      <div className="space-y-0.5">{children}</div>
    </SidebarSortableGroup>
  )
}

export function DroppableCorpusGroup({
  label,
  className,
  groupRef,
  children,
}: {
  label: string
  className?: string
  groupRef: (element: HTMLDivElement | null) => void
  children: ReactNode
}) {
  const data = useMemo(() => ({ group: label }), [label])
  const { setNodeRef } = useDroppable({ id: `sidebar-drop:${label}`, data })
  return (
    <div
      ref={(element) => {
        setNodeRef(element)
        groupRef(element)
      }}
      data-reorder-group={label}
      className={className}
    >
      {children}
    </div>
  )
}

export function SidebarSortableGroup({
  label,
  fileIds,
  children,
}: {
  label: string
  fileIds: string[]
  children: ReactNode
}) {
  return (
    <SortableContext id={`sidebar-sort:${label}`} items={fileIds} strategy={sidebarSortingStrategy}>
      {children}
    </SortableContext>
  )
}

/**
 * AQU-1702: a 2px rule where a file arriving from another group will land.
 * The rows do not slide apart for it (see `sidebarSortingStrategy`), so this
 * line is the only thing that says which slot the drop takes.
 */
function InsertionLine() {
  return (
    <span
      aria-hidden
      data-insert-slot=""
      className="absolute inset-x-1 -top-px z-10 h-0.5 rounded-full bg-primary"
    />
  )
}

export function FileListRow({
  sortable,
  id,
  group,
  draggable,
  handleLabel,
  insertBefore = false,
  children,
}: {
  sortable: boolean
  id: string
  group: string
  draggable: boolean
  /** Accessible name for the grip. Null when this row cannot start a drag. */
  handleLabel: string | null
  /** Show the AQU-1702 insertion line above this row. */
  insertBefore?: boolean
  children: ReactNode
}) {
  if (!sortable) {
    return (
      <div className="group/file-slot relative">
        {insertBefore && <InsertionLine />}
        {children}
      </div>
    )
  }
  return (
    <SortableFileSlot
      id={id}
      group={group}
      draggable={draggable}
      handleLabel={handleLabel}
      insertBefore={insertBefore}
    >
      {children}
    </SortableFileSlot>
  )
}

function SortableFileSlot({
  id,
  group,
  draggable,
  handleLabel,
  insertBefore,
  children,
}: {
  id: string
  group: string
  draggable: boolean
  handleLabel: string | null
  insertBefore: boolean
  children: ReactNode
}) {
  const data = useMemo(() => ({ group }), [group])
  const { setNodeRef, setActivatorNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id,
    data,
    transition: prefersReducedMotion() ? { duration: 0, easing: "linear" } : rowSlide,
    // Renaming: the row holds a text input. It can still be a drop slot,
    // but it must not start a drag or the pointer leaves the selection.
    disabled: draggable ? false : { draggable: true, droppable: false },
  })
  return (
    <div
      ref={setNodeRef}
      data-reorderable={draggable ? "true" : undefined}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={cn(
        "group/file-slot relative",
        // The source stays in the layout as the gap. The overlay is the row
        // the pointer is holding, so a faded copy here would be a second ghost.
        isDragging && "pointer-events-none opacity-0",
      )}
    >
      {insertBefore && <InsertionLine />}
      {draggable && handleLabel && (
        <span
          ref={setActivatorNodeRef}
          role="img"
          aria-label={handleLabel}
          data-reorder-handle=""
          style={{ touchAction: "none" }}
          className="absolute inset-y-0 -start-2 z-10 flex w-4 cursor-grab items-center justify-center text-muted-foreground opacity-0 transition-opacity group-hover/file-slot:opacity-100 active:cursor-grabbing"
          {...listeners}
          onPointerDown={(event: PointerEvent<HTMLSpanElement>) => {
            listeners?.onPointerDown?.(event)
            event.stopPropagation()
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </span>
      )}
      {children}
    </div>
  )
}
