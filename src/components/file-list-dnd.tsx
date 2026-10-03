// AQU-1647: pointer dragging for the editor file sidebar.
//
// Which slot a drop landed on lives in `file-list-dnd-model`; the numbers
// written for that slot still come from `planFileMove`. Changing groups is
// "Move to corpus…", which asks first. Keyboard reordering stays on Move up /
// Move down; there is no keyboard sensor, and the library's space-bar
// instructions are cleared so a screen reader is not told about a gesture
// this list does not offer.
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

// Hovering a different group reports overIndex -1. Shifting rows then would
// preview a move we are about to refuse.
const sameGroupVerticalStrategy: SortingStrategy = (args) => {
  if (args.overIndex < 0) return null
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

export function CorpusGroupFrame({
  droppable,
  label,
  groupRef,
  children,
}: {
  droppable: boolean
  label: string
  groupRef: (element: HTMLDivElement | null) => void
  children: ReactNode
}) {
  if (!droppable) return <div ref={groupRef}>{children}</div>
  return (
    <DroppableCorpusGroup label={label} groupRef={groupRef}>
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
  groupRef,
  children,
}: {
  label: string
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
    <SortableContext id={`sidebar-sort:${label}`} items={fileIds} strategy={sameGroupVerticalStrategy}>
      {children}
    </SortableContext>
  )
}

export function FileListRow({
  sortable,
  id,
  group,
  draggable,
  handleLabel,
  children,
}: {
  sortable: boolean
  id: string
  group: string
  draggable: boolean
  /** Accessible name for the grip. Null when this row cannot start a drag. */
  handleLabel: string | null
  children: ReactNode
}) {
  if (!sortable) {
    return <div className="group/file-slot relative">{children}</div>
  }
  return (
    <SortableFileSlot id={id} group={group} draggable={draggable} handleLabel={handleLabel}>
      {children}
    </SortableFileSlot>
  )
}

function SortableFileSlot({
  id,
  group,
  draggable,
  handleLabel,
  children,
}: {
  id: string
  group: string
  draggable: boolean
  handleLabel: string | null
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
