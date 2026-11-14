// The timeline's horizontal scroller. One LegendList, `horizontal`, whose
// items are fixed-width time columns. The columns sit in the same scrollport
// as the ruler (scrollElement), on the same pixel axis, so a tick and the
// chip under it cannot drift apart.
//
// Every column is in the list, which is what makes the scroll length the
// whole file. LegendList mounts only the columns near the viewport, and
// scrolling does not re-render the editor. The ruler listens to the scroll
// bus for which labels to draw.

import { useContext, useSyncExternalStore, type ReactNode } from "react"
import { LegendList, type LegendListRenderItemProps } from "@legendapp/list/react"
import { pxToSec } from "@/lib/timeline/scale"
import { TIMELINE_SLICE_PX, type TimeSlice } from "@/lib/timeline/horizontal-slices"
import { TimelineRuler, type TimelineRulerProps } from "./TimelineRuler"
import { TimelineScrollBusContext, emptyScrollSnap, subscribeNoScroll } from "./timeline-scroll-bus"

const OVERSCAN_PX = 240
/** Before the scrollport is measured, the bus reports a viewport of 0 and
 *  the only width on hand is the whole file. A tick every couple of seconds
 *  across that width is a hundred thousand labels on the first commit of a
 *  long book. One column covers the pane until the bus has a real viewport. */
const UNMEASURED_RULER_PX = TIMELINE_SLICE_PX

/** One column past the viewport, on each side. Every column is in `data`,
 *  so the scroll length is the whole file. Only this window is mounted. */
export const TIMELINE_DRAW_DISTANCE_PX = TIMELINE_SLICE_PX

export function TimelineScrollingRuler(
  props: Omit<TimelineRulerProps, "viewStartSec" | "viewEndSec">,
) {
  const bus = useContext(TimelineScrollBusContext)
  const snap = useSyncExternalStore(
    bus ? bus.subscribe : subscribeNoScroll,
    bus ? bus.getSnap : emptyScrollSnap,
    bus ? bus.getSnap : emptyScrollSnap,
  )
  const overscanSec = pxToSec(OVERSCAN_PX, props.pxPerSec)
  const spanPx = snap.viewport > 0 ? snap.viewport : Math.min(props.fillPx ?? 0, UNMEASURED_RULER_PX)
  return (
    <TimelineRuler
      {...props}
      viewStartSec={pxToSec(snap.left, props.pxPerSec) - overscanSec}
      viewEndSec={pxToSec(snap.left + spanPx, props.pxPerSec) + overscanSec}
    />
  )
}

export function TimelineHorizontalList({
  scrollElement,
  slices,
  extraData,
  renderSlice,
}: {
  scrollElement: HTMLElement | null
  slices: readonly TimeSlice[]
  /** Changes when the lanes' contents change, so mounted columns redraw.
   *  Scrolling does not change it. */
  extraData: number
  renderSlice: (slice: TimeSlice) => ReactNode
}) {
  return (
    <div data-tl-hlist="" data-testid="tl-hlist">
      {/* LegendList paints each column inside `contain: paint`. That stays on
          while scrolling — it is what keeps a fast horizontal scroll cheap.
          It also clips the drag readout that has to reach the ruler, and
          traps a dragging lane's z-index under the playhead, so a column
          drops the containment only while a chip is actually being dragged,
          and the list rises above the ruler. Transparent parts of the list
          still show the ruler and the playhead through. */}
      {/* i18n-exempt CSS selectors for the drag containment override, not user-visible copy */}
      <style>{`
        [data-tl-hlist]:has([data-tl-drag]) .legend-list-content-container > div { contain: none !important; }
        [data-tl-hlist]:has([data-tl-drag]) { position: relative; z-index: 30; }
      `}</style>
      <LegendList
        horizontal
        rtl={false}
        recycleItems={false}
        maintainVisibleContentPosition={false}
        scrollElement={scrollElement}
        data={slices as TimeSlice[]}
        extraData={extraData}
        keyExtractor={(slice) => slice.key}
        getFixedItemSize={(slice) => slice.widthPx}
        estimatedItemSize={TIMELINE_SLICE_PX}
        drawDistance={TIMELINE_DRAW_DISTANCE_PX}
        renderItem={({ item }: LegendListRenderItemProps<TimeSlice>) => renderSlice(item)}
      />
    </div>
  )
}
