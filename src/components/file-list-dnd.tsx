// AQU-1647: pointer dragging for the editor file sidebar.
//
// Which slot a drop landed on lives in `file-list-dnd-model`; the numbers
// written for that slot still come from `planFileMove`. Changing groups is
// "Move to corpus…", which asks first. Keyboard reordering stays on Move up /
// Move down; there is no keyboard sensor, and the library's space-bar
// instructions are cleared so a screen reader is not told about a gesture
// this list does not offer.

import { useMemo, type ReactNode } from "react"
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

export function FileDragPreview({ name }: { name: string }) {
  return (
    <div
      aria-hidden
      className="flex h-7 max-w-xs items-center gap-1 rounded-lg bg-background px-2 text-[13px] text-foreground shadow-md ring-1 ring-border"
    >
      <GripVertical className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="truncate">{name}</span>
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
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={sidebarFileCollision}
      accessibility={accessibility}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      {children}
      <DragOverlay dropAnimation={null}>{overlay}</DragOverlay>
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
  isDropTarget,
  children,
}: {
  sortable: boolean
  id: string
  group: string
  draggable: boolean
  isDropTarget: boolean
  children: ReactNode
}) {
  if (!sortable) {
    return <div className="group/file-slot relative">{children}</div>
  }
  return (
    <SortableFileSlot id={id} group={group} draggable={draggable} isDropTarget={isDropTarget}>
      {children}
    </SortableFileSlot>
  )
}

function SortableFileSlot({
  id,
  group,
  draggable,
  isDropTarget,
  children,
}: {
  id: string
  group: string
  draggable: boolean
  isDropTarget: boolean
  children: ReactNode
}) {
  const data = useMemo(() => ({ group }), [group])
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id,
    data,
    // Renaming: the row holds a text input. It can still be a drop slot,
    // but it must not start a drag or the pointer leaves the selection.
    disabled: draggable ? false : { draggable: true, droppable: false },
  })
  return (
    <div
      ref={setNodeRef}
      {...(draggable ? listeners : undefined)}
      data-reorderable={draggable ? "true" : undefined}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={cn(
        "group/file-slot relative",
        draggable && "cursor-grab",
        isDropTarget && "rounded-md ring-1 ring-primary/60",
        isDragging && "opacity-50",
      )}
    >
      {children}
    </div>
  )
}
