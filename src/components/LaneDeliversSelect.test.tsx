import { describe, it, expect } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { LaneDeliversSelect } from "./LaneDeliversSelect"

// The Delivers list sits low in a language's row, often near the bottom of a
// dialog. Laid over its button (the Select default) it was cut off and showed
// one choice with scroll arrows; it now opens below the button, uncapped.
describe("LaneDeliversSelect", () => {
  it("opens below its button with all three choices and no height limit", async () => {
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
    expect(popup.style.maxHeight).toBe("none")
  })
})
