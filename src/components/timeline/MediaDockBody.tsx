// The row under the timeline: the Bottom left and Bottom right areas, each a
// resizable panel with its 24 px strip and an empty content box that the
// dock's hosts (the film, the text) are moved into. (Media redesign, layout.)
//
// The areas are keyed panels, so an area keeps its DOM box while the other
// one comes and goes — which is what lets the text sit still, mounted, across
// a trip to the text lens and back.

import { Fragment } from "react"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { cn } from "@/lib/utils"
import { DOCK_AREAS, type DockArea } from "./media-dock-layout"
import { MediaAreaStrip, useAreaDrop } from "./MediaPanelChrome"
import type { MediaDock } from "./useMediaDock"

function MediaArea({ dock, area, stacked, first }: { dock: MediaDock; area: DockArea; stacked: boolean; first: boolean }) {
  const drop = useAreaDrop(dock, area)
  const open = !stacked || dock.view.isOpen(area)
  const frozen = !open ? dock.frozen[area] : undefined
  return (
    <ResizablePanel
      id={`media-${area}`}
      panelRef={dock.panelRefs[area]}
      {...(stacked ? dock.constraints[area] : {})}
      // Only the film's area has a remembered width; its neighbour takes the
      // rest, as the table always has.
      defaultSize={stacked && area === dock.filmArea ? dock.defaults.filmWidth : undefined}
      // A folded panel clips rather than reflows: the library's own content
      // box is `overflow: auto`, so without this the frozen content would
      // scroll in the zero-width sliver instead of being hidden.
      style={!open ? { overflow: "hidden" } : undefined}
      onResize={(size) => dock.noteResize(area, size.inPixels)}
    >
      <div
        data-media-region={area}
        data-testid={`dock-area-${area}`}
        {...(stacked ? drop.props : {})}
        className={cn(
          "flex h-full min-h-0 min-w-0 flex-col",
          // The line between the two areas, on the right-hand one.
          stacked && !first && "border-s border-border",
          drop.className,
        )}
      >
        {stacked && <MediaAreaStrip dock={dock} area={area} />}
        <div
          ref={dock.boxRefs[area]}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          // Folded, the content keeps the size it last had, so nothing in it
          // re-lays-out at zero and it comes back exactly as it went.
          style={frozen ? { minWidth: frozen.width, minHeight: frozen.height } : undefined}
          inert={!open || undefined}
        />
      </div>
    </ResizablePanel>
  )
}

export function MediaDockBody({ dock, stacked }: { dock: MediaDock; stacked: boolean }) {
  const v = dock.view
  // The text lens shows the text alone, in whichever area holds it, so that
  // area's box — and the table in it — is the same element in both lenses.
  const areas: DockArea[] = stacked ? DOCK_AREAS.filter((a) => v.exists(a)) : [v.areaOf("text") ?? "lr"]
  const disabled = dock.separatorDisabled("ll-lr")
  return (
    <ResizablePanelGroup
      id="media-lens-body"
      orientation="horizontal"
      className="min-h-0 flex-1"
      onLayoutChanged={(_layout, meta) => dock.noteLayoutSettled(meta)}
    >
      {areas.map((area, i) => (
        <Fragment key={area}>
          {i > 0 ? (
            // Beside a folded area there is nothing to drag: the handle goes
            // too, rather than floating at the edge.
            <ResizableHandle withHandle disabled={disabled} className={disabled ? "invisible" : undefined} />
          ) : null}
          <MediaArea dock={dock} area={area} stacked={stacked} first={i === 0 || !v.isOpen(areas[0])} />
        </Fragment>
      ))}
    </ResizablePanelGroup>
  )
}
