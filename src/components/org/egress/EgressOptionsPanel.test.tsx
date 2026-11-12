// AQU-1575: "Every clip separately" can write each clip as 16-bit / 48 kHz /
// mono WAV, the broadcast deliverable. The choice shows only on that mode —
// every other mode already writes that WAV — and goes through the same
// onChange the page persists per organization.

import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { EgressOptionsPanel } from "./EgressOptionsPanel"
import { DEFAULT_EGRESS_OPTIONS } from "@/lib/store/egress-prefs"
import type { EgressOptions } from "@/lib/egress/types"

const ESTIMATE = { files: 1, cells: 2, recordedMs: 0 }
const LANES = [{ lane: "", label: "Arabic" }]

const renderPanel = (options: EgressOptions, onChange = vi.fn()) => {
  render(<EgressOptionsPanel options={options} onChange={onChange} laneOptions={LANES} estimate={ESTIMATE} />)
  return onChange
}

describe("the WAV choice in Data egress (AQU-1575)", () => {
  it("is offered on separate clips and reports a tick as the WAV format", async () => {
    const onChange = renderPanel({ ...DEFAULT_EGRESS_OPTIONS, audioMode: "separate-clips" })
    const box = screen.getByTestId("egress-audio-wav")
    expect(box).toHaveAttribute("aria-checked", "false")
    await userEvent.click(box)
    expect(onChange).toHaveBeenCalledWith({ audioFormat: "wav" })
  })

  it("shows a saved WAV choice as ticked, and unticking goes back to the original files", async () => {
    const onChange = renderPanel({ ...DEFAULT_EGRESS_OPTIONS, audioMode: "separate-clips", audioFormat: "wav" })
    const box = screen.getByTestId("egress-audio-wav")
    expect(box).toHaveAttribute("aria-checked", "true")
    await userEvent.click(box)
    expect(onChange).toHaveBeenCalledWith({ audioFormat: "original" })
  })

  it("is not offered on the modes that always write WAV", () => {
    renderPanel({ ...DEFAULT_EGRESS_OPTIONS, audioMode: "voice-timeline" })
    expect(screen.queryByTestId("egress-audio-wav")).toBeNull()
  })
})
