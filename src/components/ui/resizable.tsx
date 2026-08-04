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
        // Idle: transparent hit target; hover / drag / focus paint a vertical
        // (or horizontal) drag line via data-separator states from the library.
        "relative flex w-px cursor-col-resize items-center justify-center bg-transparent ring-offset-background after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:cursor-row-resize aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90",
        "hover:bg-border [&[data-separator=hover]]:bg-border [&[data-separator=active]]:bg-foreground/40 [&[data-separator=focus]]:bg-ring",
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
