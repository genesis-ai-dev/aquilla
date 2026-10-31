// AQU-2327, items 21–22: the fade corners and the volume line over the lane.
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
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
})
