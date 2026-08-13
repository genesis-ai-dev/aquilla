import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
} from "react"
import { cn } from "@/lib/utils"

interface EditorCellHeaderLaneProps extends HTMLAttributes<HTMLDivElement> {
  align?: "start" | "center"
}

/**
 * The quiet metadata lane above editor text. Keeping this shared preserves the
 * source/target baseline in the main editor and in alternate editor layouts.
 */
export function EditorCellHeaderLane({
  align = "start",
  className,
  ...props
}: EditorCellHeaderLaneProps) {
  return (
    <div
      {...props}
      dir="ltr"
      className={cn(
        "mb-1 flex h-4 items-center gap-2 text-xs text-muted-foreground",
        align === "center" ? "justify-center text-center" : "justify-between",
        className,
      )}
    />
  )
}

interface EditorSourceCellSurfaceProps extends HTMLAttributes<HTMLDivElement> {
  header?: ReactNode
  overlay?: ReactNode
  editing?: boolean
  busy?: boolean
  fontSize?: number
  reserveAction?: boolean
}

/** Shared source-cell chrome used by every editor presentation. */
export const EditorSourceCellSurface = forwardRef<HTMLDivElement, EditorSourceCellSurfaceProps>(
  function EditorSourceCellSurface({
    header,
    overlay,
    editing = false,
    busy = false,
    fontSize = 14,
    reserveAction = true,
    className,
    style,
    children,
    ...props
  }, ref) {
    return (
      <div
        {...props}
        ref={ref}
        data-editor-cell-surface="source"
        data-cell-type="source"
        className={cn(
          "relative flex h-full min-h-[40px] flex-col rounded-lg px-2 py-1.5 transition-[colors,opacity]",
          reserveAction ? "pr-7" : "pr-2",
          "focus-within:bg-muted focus-within:ring-1 focus-within:ring-ring/40 focus-within:ring-inset",
          editing && "bg-muted ring-1 ring-ring/40 ring-inset",
          busy && "opacity-70",
          className,
        )}
        style={{ fontSize: `${fontSize}px`, lineHeight: "1.6", ...style }}
      >
        {overlay}
        <EditorCellHeaderLane align="center" data-testid="source-context-line">
          {header}
        </EditorCellHeaderLane>
        {children}
      </div>
    )
  },
)

interface EditorTargetCellColumnProps extends HTMLAttributes<HTMLDivElement> {
  header?: ReactNode
  leading?: ReactNode
  busy?: boolean
  fontSize?: number
  reserveActionRail?: boolean
}

/** Shared target-column shell; optional rail space is only needed in the grid. */
export function EditorTargetCellColumn({
  header,
  leading,
  busy = false,
  fontSize = 14,
  reserveActionRail = true,
  className,
  style,
  children,
  ...props
}: EditorTargetCellColumnProps) {
  return (
    <div
      {...props}
      data-editor-cell-surface="target-column"
      data-cell-type="target-column"
      dir="ltr"
      className={cn(
        "relative flex flex-col pl-3 transition-opacity",
        reserveActionRail ? "pr-9" : "pr-3",
        busy && "opacity-70",
        className,
      )}
      style={{ fontSize: `${fontSize}px`, lineHeight: "1.6", ...style }}
    >
      {leading}
      <EditorCellHeaderLane data-testid="target-header-lane">
        {header}
      </EditorCellHeaderLane>
      {children}
    </div>
  )
}

interface EditorTargetCellWellProps extends HTMLAttributes<HTMLDivElement> {
  empty?: boolean
  compact?: boolean
}

/** The target cell's hover/focus well, shared independently of editing state. */
export function EditorTargetCellWell({
  empty = false,
  compact = false,
  className,
  ...props
}: EditorTargetCellWellProps) {
  return (
    <div
      {...props}
      data-editor-cell-surface="target"
      data-cell-type="target"
      className={cn(
        "relative flex min-h-[40px] flex-1 flex-col rounded-lg px-2 py-1.5 transition-colors",
        compact && "min-h-0 py-0.5",
        "hover:bg-muted/60 focus-within:bg-muted focus-within:ring-1 focus-within:ring-ring/40 focus-within:ring-inset",
        empty && "bg-muted/40",
        className,
      )}
    />
  )
}

interface EditorTargetReadSurfaceProps extends HTMLAttributes<HTMLDivElement> {
  editable?: boolean
  empty?: boolean
  subdued?: boolean
}

/** Cheap read surface that upgrades to TranslatedEditor only when activated. */
export const EditorTargetReadSurface = forwardRef<HTMLDivElement, EditorTargetReadSurfaceProps>(
  function EditorTargetReadSurface({
    editable = false,
    empty = false,
    subdued = false,
    className,
    ...props
  }, ref) {
    return (
      <div
        {...props}
        ref={ref}
        data-editor-cell-surface="target-read"
        role="textbox"
        aria-multiline="true"
        className={cn(
          "relative min-h-[40px] w-full flex-1 whitespace-pre-wrap rounded-lg px-1 py-0.5 leading-relaxed text-foreground/90 outline-none",
          editable && "cursor-text focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-1",
          subdued && "opacity-30 transition-opacity",
          empty && "text-muted-foreground/60",
          className,
        )}
      />
    )
  },
)
