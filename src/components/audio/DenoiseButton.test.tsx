// The inline "Remove noise" affordance has three states driven by the selected
// take, plus a revert. These matter because the button is the primary, at-a-
// glance signal of whether a cell's audio has been cleaned — a wrong state
// (offering denoise on an already-clean take, or losing the revert path back to
// the original) misleads the translator about which audio is live.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

const denoiseTake = vi.fn(async () => ({ audioId: "dn-x.webm", url: "frontier-audio://dn-x.webm", durationMs: 1000 }))
const emitSelect = vi.fn(async (..._a: unknown[]) => "evt")
const inject = vi.fn((..._a: unknown[]) => {})
const notify = vi.fn((..._a: unknown[]) => {})

vi.mock("@/lib/audio/denoise", () => ({ isDenoiseSupported: () => true }))
vi.mock("@/lib/audio/denoise-take", () => ({ denoiseTake: (...a: unknown[]) => denoiseTake(...(a as [])) }))
vi.mock("@/lib/sync/events-emit", () => ({ emitCellAudioSelect: (...a: unknown[]) => emitSelect(...a) }))
vi.mock("@/lib/audio/audio-attachments-bus", () => ({
  injectOptimisticAudioAttachment: (...a: unknown[]) => inject(...a),
  notifyAudioAttachmentsChanged: (...a: unknown[]) => notify(...a),
}))

import { DenoiseButton } from "./DenoiseButton"

const session = { jwt: "jwt", username: "dir" } as never

const base = {
  projectId: "p1",
  fileId: "f1",
  cellId: "c1",
  author: "dir",
  session,
  editable: true,
}

beforeEach(() => {
  denoiseTake.mockClear()
  emitSelect.mockClear()
  inject.mockClear()
  notify.mockClear()
})

describe("DenoiseButton", () => {
  it("offers 'Remove noise' on an original take and runs denoise on click", async () => {
    render(
      <DenoiseButton
        {...base}
        selectedAudioId="audio-a.webm"
        selectedUrl="frontier-audio://audio-a.webm"
        referenceAudioId={null}
        originalUrl={null}
        originalDurationMs={null}
      />,
    )
    const btn = screen.getByText("Remove noise")
    expect(btn).toBeTruthy()
    fireEvent.click(btn)
    await waitFor(() => expect(denoiseTake).toHaveBeenCalledTimes(1))
    expect(denoiseTake).toHaveBeenCalledWith(
      expect.objectContaining({
        cellId: "c1",
        sourceAudioId: "audio-a.webm",
        sourceUrl: "frontier-audio://audio-a.webm",
      }),
    )
  })

  it("shows 'Noise removed' + 'Revert' when a denoised take is selected", () => {
    render(
      <DenoiseButton
        {...base}
        selectedAudioId="dn-audio-c.webm"
        selectedUrl="frontier-audio://dn-audio-c.webm"
        referenceAudioId="audio-a.webm"
        originalUrl="frontier-audio://audio-a.webm"
        originalDurationMs={1500}
      />,
    )
    expect(screen.getByText("Noise removed")).toBeTruthy()
    expect(screen.getByText("Revert")).toBeTruthy()
    expect(screen.queryByText("Remove noise")).toBeNull()
  })

  it("revert selects the original take and optimistically re-injects it", async () => {
    render(
      <DenoiseButton
        {...base}
        selectedAudioId="dn-audio-c.webm"
        selectedUrl="frontier-audio://dn-audio-c.webm"
        referenceAudioId="audio-a.webm"
        originalUrl="frontier-audio://audio-a.webm"
        originalDurationMs={1500}
      />,
    )
    fireEvent.click(screen.getByText("Revert"))
    await waitFor(() => expect(emitSelect).toHaveBeenCalledTimes(1))
    expect(emitSelect).toHaveBeenCalledWith(
      expect.objectContaining({ audioId: "audio-a.webm", slot: "recording", cellId: "c1" }),
    )
    // Optimistic re-inject of the original flips selection instantly.
    expect(inject).toHaveBeenCalledWith(
      "f1",
      "c1",
      expect.objectContaining({ audioId: "audio-a.webm", slot: "recording" }),
    )
    expect(notify).toHaveBeenCalledWith("f1")
  })

  it("omits Revert on a denoised take whose source is unknown", () => {
    render(
      <DenoiseButton
        {...base}
        selectedAudioId="dn-audio-c.webm"
        selectedUrl="frontier-audio://dn-audio-c.webm"
        referenceAudioId={null}
        originalUrl={null}
        originalDurationMs={null}
      />,
    )
    expect(screen.getByText("Noise removed")).toBeTruthy()
    expect(screen.queryByText("Revert")).toBeNull()
  })

  it("disables denoise when not editable", () => {
    render(
      <DenoiseButton
        {...base}
        editable={false}
        selectedAudioId="audio-a.webm"
        selectedUrl="frontier-audio://audio-a.webm"
        referenceAudioId={null}
        originalUrl={null}
        originalDurationMs={null}
      />,
    )
    const btn = screen.getByText("Remove noise").closest("button")!
    expect(btn.disabled).toBe(true)
  })
})
