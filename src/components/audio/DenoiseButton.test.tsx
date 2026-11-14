// The inline "Remove noise" affordance has three states driven by the selected
// take, plus a revert. These matter because the button is the primary, at-a-
// glance signal of whether a cell's audio has been cleaned — a wrong state
// (offering denoise on an already-clean take, or losing the revert path back to
// the original) misleads the translator about which audio is live.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { renderWithTooltips } from "@/test-utils/tooltip"

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

// AQU-2492 (review, Nov 9): the Undo steps the button records.
const steps = vi.hoisted(() => [] as Array<Record<string, unknown>>)
vi.mock("@/lib/history/history", async (orig) => ({
  ...(await orig<typeof import("@/lib/history/history")>()),
  recordStep: (step: Record<string, unknown>) => { steps.push(step) },
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
  steps.length = 0
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
    // Optimistic re-inject of the original flips selection instantly, bound to
    // the select event so it lives exactly as long as that event is queued.
    expect(inject).toHaveBeenCalledWith(
      "f1",
      "c1",
      expect.objectContaining({ audioId: "audio-a.webm", slot: "recording" }),
      expect.anything(),
    )
    expect(notify).toHaveBeenCalledWith("f1")
  })

  // AQU-2492 (review, Nov 9): going back to the original left no Undo step,
  // so ⌘Z after it undid something else.
  it("going back to the original is an Undo step: the cleaned take plays again", async () => {
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
    await waitFor(() => expect(steps).toHaveLength(1))
    expect(steps[0]).toMatchObject({
      kind: "take.select",
      labelKey: "editor.history.stepRevertNoise",
      fileId: "f1",
      data: { cellId: "c1", slot: "recording", before: "dn-audio-c.webm", after: "audio-a.webm" },
    })
  })

  it("a split take's step names both takes by their groups, on the take's own track", async () => {
    const piece = (audioId: string, pieceOf: string | null, referenceAudioId: string | null) => ({
      audioId, url: `frontier-audio://${audioId}`, slot: "track-2", mimeType: null, voiceId: null,
      referenceAudioId, durationMs: 1000, trimStartMs: null, trimEndMs: null, pieceOf,
    })
    render(
      <DenoiseButton
        {...base}
        selectedAudioId="dn-a1.webm"
        selectedUrl="frontier-audio://dn-a1.webm"
        referenceAudioId="a1.webm"
        originalUrl={null}
        originalDurationMs={null}
        pieces={[piece("dn-a1.webm", null, "a1.webm"), piece("dn-a2.webm", "dn-a1.webm", "a2.webm")] as never}
        originalTake={piece("a1.webm", null, null) as never}
      />,
    )
    fireEvent.click(screen.getByText("Revert"))
    await waitFor(() => expect(steps).toHaveLength(1))
    expect(steps[0]).toMatchObject({ data: { cellId: "c1", slot: "track-2", before: "dn-a1.webm", after: "a1.webm" } })
  })

  // AQU-2492 (review, Nov 9), finding 6: a whole take on an added track is
  // chosen on ITS track. Choosing the original on the main track unchose the
  // line's main-track recording, and left two takes playing on the added one.
  it("a whole take on an added track goes back to the original on that track, and its step names that track", async () => {
    render(
      <DenoiseButton
        {...base}
        selectedAudioId="dn-audio-t.webm"
        selectedUrl="frontier-audio://dn-audio-t.webm"
        referenceAudioId="audio-t.webm"
        originalUrl="frontier-audio://audio-t.webm"
        originalDurationMs={1500}
        source={{ slot: "track-narrator" }}
      />,
    )
    fireEvent.click(screen.getByText("Revert"))
    await waitFor(() => expect(steps).toHaveLength(1))
    expect(emitSelect).toHaveBeenCalledWith(expect.objectContaining({ audioId: "audio-t.webm", slot: "track-narrator" }))
    expect(inject).toHaveBeenCalledWith("f1", "c1", expect.objectContaining({ audioId: "audio-t.webm", slot: "track-narrator" }), expect.anything())
    expect(steps[0]).toMatchObject({ data: { cellId: "c1", slot: "track-narrator", before: "dn-audio-t.webm", after: "audio-t.webm" } })
  })

  it("a refused revert records nothing", async () => {
    emitSelect.mockRejectedValueOnce(new Error("offline"))
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
    await act(() => new Promise((r) => setTimeout(r, 10)))
    expect(steps).toEqual([])
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

// AQU-2260 (Sam, Oct 29): a hover may only NAME an icon-only button. The
// badge and both buttons carry their own words, so none has a hover.
describe("DenoiseButton — no hover", () => {
  async function expectNoHover(el: Element) {
    await userEvent.setup().hover(el)
    await act(() => new Promise((r) => setTimeout(r, 30)))
    expect(screen.queryByRole("tooltip")).toBeNull()
  }

  it("Remove noise has no hover", async () => {
    renderWithTooltips(
      <DenoiseButton {...base} selectedAudioId="audio-a.webm" selectedUrl="frontier-audio://audio-a.webm"
        referenceAudioId={null} originalUrl={null} originalDurationMs={null} />,
    )
    await expectNoHover(screen.getByRole("button", { name: /Remove noise/ }))
  })

  it("Noise removed and Revert have no hover", async () => {
    renderWithTooltips(
      <DenoiseButton {...base} selectedAudioId="dn-audio-c.webm" selectedUrl="frontier-audio://dn-audio-c.webm"
        referenceAudioId="audio-a.webm" originalUrl="frontier-audio://audio-a.webm" originalDurationMs={1500} />,
    )
    await expectNoHover(screen.getByText("Noise removed"))
    await expectNoHover(screen.getByRole("button", { name: /Revert/ }))
  })
})
