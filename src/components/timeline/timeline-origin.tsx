// A mounted time column is only one slice wide. Chips inside it are positioned
// from that column's left edge, so the browser never lays out a box the width
// of the whole book. Outside a column (tests, the unmeasured fallback) the
// origin is 0 and a chip's `left` stays a canvas coordinate.
import { createContext, useContext, type ReactNode } from "react"

const TimelineOriginContext = createContext(0)

export function TimelineOrigin({ px, children }: { px: number; children: ReactNode }) {
  return <TimelineOriginContext.Provider value={px}>{children}</TimelineOriginContext.Provider>
}

export function useTimelineOriginPx(): number {
  return useContext(TimelineOriginContext)
}
