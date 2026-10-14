// AQU-1954 — "This project records audio", the first row of the audio card.

import { describe, it, expect, vi } from "vitest"
import { fireEvent, screen, waitFor } from "@testing-library/react"
import { renderWithTooltips } from "@/test-utils/tooltip"
import { RecordsAudioProjectSection } from "./RecordsAudioProjectSection"

function renderRow(value: boolean | undefined, onPatch = vi.fn(async () => ({ kind: "ok" })), disabled = false) {
  renderWithTooltips(<RecordsAudioProjectSection value={value} disabled={disabled} onPatch={onPatch} />)
  return { onPatch, toggle: screen.getByRole("switch", { name: "This project records audio" }) }
}

describe("RecordsAudioProjectSection", () => {
  it("reads an absent key as off", () => {
    const { toggle } = renderRow(undefined)
    expect(toggle).toHaveAttribute("aria-checked", "false")
  })

  it("saves the new value straight to the project", async () => {
    const { onPatch, toggle } = renderRow(false)
    fireEvent.click(toggle)
    await waitFor(() => expect(onPatch).toHaveBeenCalledWith({ recordsAudio: true }))
  })

  it("turns it back off as an explicit false", async () => {
    const { onPatch, toggle } = renderRow(true)
    expect(toggle).toHaveAttribute("aria-checked", "true")
    fireEvent.click(toggle)
    await waitFor(() => expect(onPatch).toHaveBeenCalledWith({ recordsAudio: false }))
  })

  it("says so when the save fails", async () => {
    const { toggle } = renderRow(false, vi.fn(async () => ({ kind: "error", message: "Nope" })))
    fireEvent.click(toggle)
    expect(await screen.findByText("Nope")).toBeInTheDocument()
  })

  it("cannot be changed by someone who may not edit the project", () => {
    const { onPatch, toggle } = renderRow(false, undefined, true)
    fireEvent.click(toggle)
    expect(onPatch).not.toHaveBeenCalled()
  })
})
