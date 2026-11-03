import { describe, it, expect, vi } from "vitest"
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

// Sam, Oct 28: "incredibly wordy". The card's (i) is a button that opens more
// on each choice inside each choice, and closes it again (not a hover).
// Oct 29: names alone were "on the edge of too much hidden", so each choice
// also says one short phrase, always.
describe("Audio loading card", () => {
  it("gives every choice its name and one short phrase, with the (i) shut", () => {
    render(<AudioMediaStrategySection value="lazy" onChange={() => {}} />)
    const phrase = (name: RegExp) => screen.getByRole("button", { name }).textContent
    expect(phrase(/^Lazy \(default\)/)).toContain("Waveforms load as they come into view")
    expect(phrase(/^Eager/)).toContain("Every waveform loads when a file opens")
    expect(phrase(/^Stream/)).toContain("Waveforms wait for a click")
    expect(phrase(/^Manual/)).toContain("Waveforms wait for a click")
    expect(screen.getByText("Every waveform loads when a file opens")).toBeVisible()
    expect(document.getElementById("settings-audio-media-eager-explanation")).toHaveAttribute("aria-hidden", "true")
  })

  it("opens the explanations inside the choices on a click of its (i), and closes them on another", () => {
    render(<AudioMediaStrategySection value="lazy" onChange={() => {}} />)
    const info = screen.getByTestId("settings-audio-media-info")
    const stream = document.getElementById("settings-audio-media-stream-explanation") as HTMLElement
    expect(info).toHaveAttribute("aria-expanded", "false")
    expect(stream.dataset.open).toBe("false")
    expect(stream).toHaveAttribute("aria-hidden", "true")
    expect(screen.getByRole("button", { name: /^Stream/ }).contains(stream)).toBe(true)
    fireEvent.click(info)
    expect(info).toHaveAttribute("aria-expanded", "true")
    expect(stream.dataset.open).toBe("true")
    expect(stream).toHaveAttribute("aria-hidden", "false")
    fireEvent.click(info)
    expect(stream.dataset.open).toBe("false")
  })

  it("opening the (i) doesn't pick a choice", () => {
    const onChange = vi.fn()
    render(<AudioMediaStrategySection value="lazy" onChange={onChange} />)
    fireEvent.click(screen.getByTestId("settings-audio-media-info"))
    expect(onChange).not.toHaveBeenCalled()
  })
})
