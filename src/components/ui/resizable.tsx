import * as ResizablePrimitive from "react-resizable-panels"

import { cn } from "@/lib/utils"

function ResizablePanelGroup({
  className,
  disableCursor: _disableCursor,
  ...props
}: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      // Always on: library would inject `*, *:hover { cursor: grab !important }`
      // over the hit region (breadcrumb, dock chrome, etc.). Handle cursors are
      // set explicitly on ResizableHandle (col/row-resize — never the hand).
      {...props}
      disableCursor
      className={cn(
        "flex h-full w-full aria-[orientation=vertical]:flex-col",
        className
      )}
    />
  )
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        // Resize affordance lives on the handle only (col/row arrows) — never
        // the hand/grab cursor. Library-wide cursor injection stays disabled
        // on ResizablePanelGroup so breadcrumb/dock chrome aren't painted over.
        // Hit target is w-1.5 with negative margin so it overlaps neighbors
        // without eating layout space. The visible drag line is a centered
        // 2px muted pseudo — hover and drag start share the slop.
        "relative z-20 flex w-1.5 shrink-0 -mx-[3px] cursor-col-resize items-center justify-center bg-transparent ring-offset-background focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
        "before:pointer-events-none before:absolute before:inset-y-0 before:left-1/2 before:w-0.5 before:-translate-x-1/2 before:bg-muted-foreground/50 before:opacity-0 before:transition-opacity",
        // Visible on hover or while actively dragging.
        "hover:before:opacity-100 [&[data-separator=hover]]:before:opacity-100 [&[data-separator=active]]:before:opacity-100",
        "aria-[orientation=horizontal]:mx-0 aria-[orientation=horizontal]:-my-[3px] aria-[orientation=horizontal]:h-1.5 aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:cursor-row-resize",
        "aria-[orientation=horizontal]:before:inset-x-0 aria-[orientation=horizontal]:before:top-1/2 aria-[orientation=horizontal]:before:left-0 aria-[orientation=horizontal]:before:h-0.5 aria-[orientation=horizontal]:before:w-full aria-[orientation=horizontal]:before:-translate-y-1/2 aria-[orientation=horizontal]:before:translate-x-0",
        "[&[aria-orientation=horizontal]>div]:rotate-90",
        className
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-6 w-1 shrink-0 rounded-lg bg-border" />
      )}
    </ResizablePrimitive.Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
