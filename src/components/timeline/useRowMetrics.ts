// The live row geometry (AQU-646 stage 3), published to everything the timeline
// draws inside a row.
//
// A CONTEXT rather than props for two reasons, both of which a prop would cost
// us. First, the numbers are needed at the leaves — TimelineCard's degradation
// gates, the lanes' slot buttons, TargetAudioLane's grips — which are three
// components below the editor that owns `rowH`, and none of the components in
// between have any use for them. Second, the default value means every focused
// test keeps working untouched: a TimelineCard mounted on its own reads the
// shipped 10-46-10 row, matching the fallbacks baked into TL_CHIP_BOX_CLASS.
//
// Plain .ts, no provider component: TimelineEditor renders
// `<RowMetricsContext.Provider>` directly, and keeping this file JSX-free lets
// the pure modules import the shape without pulling in a component.

import { createContext, useContext } from "react"
import { CHIP_PAD_MAX, ROW_H_DEFAULT, chipHeightPx } from "@/lib/timeline/row-metrics"

export interface RowMetrics {
  /** Full row height in px, including the padding above and below the chip. */
  rowH: number
  /** Chip height in px — what the degradation gates are compared against. */
  chipH: number
  /** Air above the chip; also its `top` offset within the row. */
  chipPad: number
}

/** Today's row. Also what any consumer outside a timeline sees. */
export const ROW_METRICS_DEFAULT: RowMetrics = {
  rowH: ROW_H_DEFAULT,
  chipH: chipHeightPx(ROW_H_DEFAULT),
  chipPad: CHIP_PAD_MAX,
}

export const RowMetricsContext = createContext<RowMetrics>(ROW_METRICS_DEFAULT)

export const useRowMetrics = (): RowMetrics => useContext(RowMetricsContext)
