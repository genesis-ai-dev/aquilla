import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { timeSlices } from "@/lib/timeline/horizontal-slices"
import { TIMELINE_DRAW_DISTANCE_PX, TimelineHorizontalList, TimelineScrollingRuler } from "./TimelineHorizontalList"

const listProps: { data?: unknown[]; drawDistance?: number } = {}

vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: { data?: unknown[]; drawDistance?: number }) => {
    listProps.data = props.data
    listProps.drawDistance = props.drawDistance
    return <div data-testid="legend-list" />
  },
}))

describe("TimelineHorizontalList", () => {
  it("gives LegendList every time column and draws only a window of them", () => {
    const canvas = 100_000
    const slices = timeSlices(canvas, 38)
    expect(slices.length).toBeGreaterThan(32)
    render(
      <TimelineHorizontalList
        scrollElement={null}
        slices={slices}
        extraData={1}
        renderSlice={() => null}
      />,
    )
    expect(listProps.data).toHaveLength(slices.length)
    expect(listProps.drawDistance).toBe(TIMELINE_DRAW_DISTANCE_PX)
    expect(listProps.drawDistance).toBeLessThan(canvas)
  })

  it("draws the first column of ruler ticks before the scrollport is measured", () => {
    render(
      <TimelineScrollingRuler
        durationSec={200_000}
        pxPerSec={38}
        fillPx={7_600_000}
        onScrub={() => {}}
      />,
    )
    const ruler = screen.getByTestId("tl-ruler")
    expect(ruler.textContent).toContain("0:00")
    expect(ruler.textContent).not.toContain("2:00")
  })
})
