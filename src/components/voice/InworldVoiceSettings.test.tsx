/**
 * InworldVoiceSettings — playground knobs on the New Voice dialog (AQU-1189).
 */

import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { InworldVoiceSettings } from "./InworldVoiceSettings"
import type { Voice } from "@/lib/parsers/types"

function renderSettings(voice: Pick<Voice, "speakingRate" | "deliveryMode" | "audioQuality"> = {}) {
  const onChange = vi.fn()
  render(<InworldVoiceSettings voice={voice} onChange={onChange} />)
  return { onChange }
}

describe("InworldVoiceSettings", () => {
  it("defaults to Highest quality with Delivery enabled", () => {
    renderSettings()
    expect(screen.getByRole("switch", { name: "Audio quality" })).toBeChecked()
    expect(screen.getByText("Highest")).toBeTruthy()
    expect(screen.getByRole("group", { name: "Delivery" })).not.toHaveAttribute("data-disabled")
    expect(screen.getByText("1x")).toBeTruthy()
  })

  it("links Highest quality to Inworld steering best practices", () => {
    renderSettings()
    const slider = screen.getByRole("group", { name: "Delivery" })
    const captions = screen.getByText("More Creative")
    const link = screen.getByRole("link", { name: "Best practices" })
    expect(link.getAttribute("href")).toBe("https://docs.inworld.ai/tts/capabilities/steering")
    expect(link.getAttribute("target")).toBe("_blank")
    expect(slider.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(captions.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("hides steering best practices on Standard quality", () => {
    renderSettings({ audioQuality: "standard" })
    expect(screen.getByText("Standard")).toBeTruthy()
    expect(screen.queryByRole("link", { name: "Best practices" })).toBeNull()
  })

  it("turning on Highest quality from Standard unlocks Delivery and persists STABLE", async () => {
    const user = userEvent.setup()
    const { onChange } = renderSettings({ audioQuality: "standard" })
    await user.click(screen.getByRole("switch", { name: "Audio quality" }))
    expect(onChange).toHaveBeenCalledWith({
      audioQuality: "highest",
      deliveryMode: "STABLE",
    })
  })

  it("hydrates saved Highest + Creative + 0.95x", () => {
    renderSettings({ audioQuality: "highest", deliveryMode: "CREATIVE", speakingRate: 0.95 })
    expect(screen.getByRole("switch", { name: "Audio quality" })).toBeChecked()
    expect(screen.getByText("Highest")).toBeTruthy()
    expect(screen.getByRole("group", { name: "Delivery" })).not.toHaveAttribute("data-disabled")
    expect(screen.getByText("0.95x")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Reset talking speed" })).toBeEnabled()
  })

  it("reset restores native talking speed", async () => {
    const user = userEvent.setup()
    const { onChange } = renderSettings({ speakingRate: 0.95 })
    await user.click(screen.getByRole("button", { name: "Reset talking speed" }))
    expect(onChange).toHaveBeenCalledWith({ speakingRate: 1 })
  })

  it("explains that Voice Design previews ignore these knobs", () => {
    render(<InworldVoiceSettings voice={{}} onChange={vi.fn()} previewIgnored />)
    expect(
      screen.getByText("The options below only apply when you generate a line with this voice. They don't affect the voices you hear in this dialog."),
    ).toBeTruthy()
  })

  it("hides the Voice Design knobs hint on prebuilt and clone", () => {
    renderSettings()
    expect(screen.queryByText(/options below only apply/)).toBeNull()
  })
})
