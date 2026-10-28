import { describe, it, expect } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { OrgDefaultSource } from "./OrgDefaultSource"
import { AudioMediaStrategySection } from "./AudioMediaStrategySection"

// Sam, Oct 28: the "Organization default / Set for this project" menu showed one
// choice with a scroll arrow hiding the other. It opens below its button now,
// uncapped, the way the Delivers list does.
describe("OrgDefaultSource menu", () => {
  it("opens below its button with both choices and no height limit", async () => {
    render(<OrgDefaultSource id="src" settingLabel="Lock the timings" inherited orgOptionLabel="Organization default (on)" onChange={() => {}} />)
    fireEvent.click(screen.getByRole("combobox"))
    const listbox = await screen.findByRole("listbox")
    expect(within(listbox).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Organization default (on)",
      "Set for this project",
    ])
    const popup = listbox.closest("[data-align-trigger]") as HTMLElement
    expect(popup.dataset.alignTrigger).toBe("false")
    expect(popup.style.maxHeight).toBe("none")
  })
})

// Sam, Oct 28: "incredibly wordy". The four choices say only their names; what
// each does sits behind the card's one (i).
describe("Audio loading card", () => {
  it("shows the choices by name, with the explanations behind the (i)", () => {
    render(<AudioMediaStrategySection value="lazy" onChange={() => {}} />)
    expect(screen.getByRole("button", { name: "Stream" })).toBeInTheDocument()
    expect(screen.getByTestId("settings-audio-media-info")).toBeInTheDocument()
    expect(screen.queryByText(/No cache on this device/)).toBeNull()
  })
})
