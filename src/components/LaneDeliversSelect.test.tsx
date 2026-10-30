import { describe, it, expect } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { LaneDeliversSelect } from "./LaneDeliversSelect"

// The Delivers list sits low in a language's row, often near the bottom of a
// dialog. Laid over its button it was cut off and showed one choice with
// scroll arrows. Every Select now opens below its button and has no ▲ ▼ strips
// (AQU-2260), so this one needs no patch of its own.
describe("LaneDeliversSelect", () => {
  it("opens below its button with all three choices and no scroll strips", async () => {
    render(<LaneDeliversSelect value="text" onValueChange={() => {}} laneLabel="Swahili" />)
    fireEvent.click(screen.getByRole("combobox"))
    const listbox = await screen.findByRole("listbox")
    expect(within(listbox).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Text",
      "Audio",
      "Text and audio",
    ])
    const popup = listbox.closest("[data-align-trigger]") as HTMLElement
    expect(popup.dataset.alignTrigger).toBe("false")
    expect(popup.querySelector("[data-slot=select-scroll-up-button]")).toBeNull()
    expect(popup.querySelector("[data-slot=select-scroll-down-button]")).toBeNull()
  })
})
