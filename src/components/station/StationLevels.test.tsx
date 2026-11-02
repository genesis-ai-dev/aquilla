// AQU-2327, items 21–22: the fade knobs and the volume line over the lane,
// and the fade drawn on the lane.
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { FadeShapes } from "./StationLane"
import { StationLevels } from "./StationLevels"
import type { StationEditor } from "./useStationEditor"

function fakeEditor(view: { va: number; w: number }): StationEditor {
  return {
    view: { ...view, vb: view.va + view.w, zoom: 4.2 / view.w },
    level: { gainDb: 0, fadeIn: 0.3, fadeOut: 0 },
    trimA: 0,
    trimB: 4.2,
    setLiveLevel: vi.fn(),
    commitLevel: vi.fn(async () => {}),
  } as unknown as StationEditor
}

describe("the Station's fade corners and volume line", () => {
  it("shows both corners and the volume readout over the whole recording", () => {
    render(<StationLevels ed={fakeEditor({ va: 0, w: 4.2 })} lane={null} hover />)
    expect(screen.getByTestId("station-fade-in")).toBeTruthy()
    expect(screen.getByTestId("station-fade-out")).toBeTruthy()
    expect(screen.getByTestId("station-volume").textContent).toBe("0 dB")
  })

  // Found in the browser walk: zoomed in past both ends, the corners sat
  // pinned to the view's edges, marking fades that aren't there.
  it("hides a corner whose place is out of the zoomed view, as a flag is", () => {
    render(<StationLevels ed={fakeEditor({ va: 1.5, w: 1.05 })} lane={null} hover />)
    expect(screen.queryByTestId("station-fade-in")).toBeNull()
    expect(screen.queryByTestId("station-fade-out")).toBeNull()
    expect(screen.getByTestId("station-volume")).toBeTruthy()
  })

  it("puts a fade's knob on the top edge where it reaches full level, and a knob with no fade just inside its corner (Nov 2)", () => {
    render(<StationLevels ed={fakeEditor({ va: 0, w: 4.2 })} lane={null} hover />)
    const fadeIn = screen.getByTestId("station-fade-in")
    expect(fadeIn.className).toContain("rounded-full")
    expect(fadeIn.className).toContain("top-0")
    expect(fadeIn.style.left).toBe("7.143%")
    expect(screen.getByTestId("station-fade-out").style.left).toBe("calc(100.000% - 12px)")
    expect(screen.getByText("Fade in 0.30 s")).toBeTruthy()
    expect(screen.getByText("Fade out")).toBeTruthy()
  })
})

describe("a fade drawn on the lane", () => {
  it("is a line from silence at the edge up to full level, with the quieted part shaded above it", () => {
    const { container } = render(<FadeShapes clip={{ trimA: 0, trimB: 4, fadeIn: 1, fadeOut: 2, gainDb: 0 }} va={0} w={4} />)
    const polys = [...container.querySelectorAll("polygon")].map((p) => p.getAttribute("points"))
    expect(polys).toEqual(["0,0 250,0 0,100", "1000,0 500,0 1000,100"])
    const lines = [...container.querySelectorAll("line")].map((l) => [l.getAttribute("x1"), l.getAttribute("y1"), l.getAttribute("x2"), l.getAttribute("y2")])
    expect(lines).toEqual([
      ["0", "100", "250", "0"],
      ["1000", "100", "500", "0"],
    ])
  })
})
