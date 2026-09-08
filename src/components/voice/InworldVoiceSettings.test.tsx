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
  it("defaults to Standard quality with Delivery disabled", () => {
    renderSettings()
    expect(screen.getByRole("switch", { name: "Audio quality" })).not.toBeChecked()
    expect(screen.getByText("Standard")).toBeTruthy()
    expect(screen.getByRole("group", { name: "Delivery" })).toHaveAttribute("data-disabled")
    expect(screen.getByText("1x")).toBeTruthy()
  })

  it("turning on Highest quality unlocks Delivery and persists STABLE", async () => {
    const user = userEvent.setup()
    const { onChange } = renderSettings()
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
})
