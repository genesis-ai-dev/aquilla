// The Audio view's colour picker (Sam, 2026-09-26): the same six swatches the
// timeline offers, writing the same value — the file's dub-track colour.
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { AudioTrackColorPicker } from "./AudioTrackColorPicker"

describe("AudioTrackColorPicker", () => {
  it("shows the file's colour, and names it", () => {
    render(<AudioTrackColorPicker color="amber" onPick={() => {}} />)
    expect(screen.getByTestId("audio-track-color-dot").style.backgroundColor).toBe("#eba720")
    expect(screen.getByTestId("audio-track-color")).toHaveAttribute("aria-label", "Audio colour for this file: Amber")
  })

  it("reads an uncoloured file as the default green", () => {
    render(<AudioTrackColorPicker color={null} onPick={() => {}} />)
    expect(screen.getByTestId("audio-track-color")).toHaveAttribute("aria-label", "Audio colour for this file: Green")
  })

  it("offers the timeline's six, marks the current one, and writes the hue's id", async () => {
    const onPick = vi.fn()
    render(<AudioTrackColorPicker color="azure" onPick={onPick} />)
    fireEvent.click(screen.getByTestId("audio-track-color"))
    const items = await screen.findAllByRole("menuitemradio")
    expect(items.map((el) => el.textContent)).toEqual(["Cyan", "Azure", "Violet", "Magenta", "Amber", "Green"])
    expect(screen.getByRole("menuitemradio", { name: "Azure" })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByText("Audio colour for this file")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Magenta" }))
    expect(onPick).toHaveBeenCalledWith("magenta")
  })
})
