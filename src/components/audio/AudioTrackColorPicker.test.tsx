// The Audio view's colour picker (Sam, 2026-09-26): the same six swatches the
// timeline offers, writing the same value — the file's dub-track colour.
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { AudioTrackColorPicker } from "./AudioTrackColorPicker"

describe("AudioTrackColorPicker", () => {
  it("shows the file's colour, and names it", () => {
    render(<AudioTrackColorPicker color="amber" onPick={() => {}} />)
    expect(screen.getByTestId("audio-track-color-dot").style.backgroundColor).toBe("#eba720")
    expect(screen.getByTestId("audio-track-color")).toHaveAttribute("aria-label", "Audio colour: Amber")
  })

  it("reads an uncoloured file as the default green", () => {
    render(<AudioTrackColorPicker color={null} onPick={() => {}} />)
    expect(screen.getByTestId("audio-track-color")).toHaveAttribute("aria-label", "Audio colour: Green")
  })

  it("offers the timeline's six, marks the current one, and writes the hue's id", async () => {
    const onPick = vi.fn()
    render(<AudioTrackColorPicker color="azure" onPick={onPick} />)
    fireEvent.click(screen.getByTestId("audio-track-color"))
    const items = await screen.findAllByRole("menuitemradio")
    // Sam, 2026-09-28: swatches only, three across — the names are for
    // screen readers, not the screen.
    expect(items.map((el) => el.getAttribute("aria-label"))).toEqual(["Cyan", "Azure", "Violet", "Magenta", "Amber", "Green"])
    expect(items.map((el) => el.textContent)).toEqual(["", "", "", "", "", ""])
    expect(screen.getByTestId("audio-track-color-grid").className).toContain("grid-cols-3")
    expect(screen.getByRole("menuitemradio", { name: "Azure" })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByText("Audio colour")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Magenta" }))
    expect(onPick).toHaveBeenCalledWith("magenta")
  })
})
