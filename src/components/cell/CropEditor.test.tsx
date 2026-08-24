import { describe, it, expect, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { UseCellAudioResult } from "@/hooks/useCellAudio"
import { expectTooltip, renderWithTooltips } from "@/test-utils/tooltip"

vi.mock("@/components/CellWaveform", () => ({
  CellWaveform: () => <div data-testid="waveform" />,
}))

import { CropButton } from "./CropEditor"

const controller = {
  state: "idle", error: null, isPlaying: false, currentTime: 0, duration: 10,
  peaks: [], peaksState: "idle",
  play: vi.fn(), pause: vi.fn(), seek: vi.fn(), setVolume: vi.fn(),
  setTrim: vi.fn(), requestPeaks: vi.fn(), ensureBytes: vi.fn(),
} as unknown as UseCellAudioResult

describe("CropEditor", () => {
  it("shows a tooltip on the crop trigger", async () => {
    renderWithTooltips(
      <CropButton
        controller={controller}
        trim={{ start: 1, end: 8 }}
        onChange={() => {}}
      />,
    )
    await expectTooltip(screen.getByRole("button", { name: "Crop audio" }), "Crop audio")
  })

  it("is an icon button named for screen readers, with no visible Reset label", async () => {
    const user = userEvent.setup()
    renderWithTooltips(
      <CropButton
        controller={controller}
        trim={{ start: 1, end: 8 }}
        onChange={() => {}}
      />,
    )

    await user.click(screen.getByRole("button", { name: "Crop audio" }))
    const reset = screen.getByRole("button", { name: "Reset to full clip" })
    expect(reset.textContent?.trim()).toBe("")
    expect(screen.queryByText(/^Reset$/)).toBeNull()
  })
})
