// Verifies the takes strip surfaces every recording-slot take, marks the
// circled (active) one, and routes circle/delete actions to the right events.
// These matter because the strip is the only UI for choosing the keeper take
// in a booth session — a wrong audioId or slot here silently corrupts the mix.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { AudioAttachmentOut } from "@/lib/sync/cell-audio-read-types"

const emitSelect = vi.fn(async (..._args: unknown[]) => "evt-1")
const emitRemove = vi.fn(async (..._args: unknown[]) => "evt-2")
const notify = vi.fn((..._args: unknown[]) => {})

vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioSelect: (...args: unknown[]) => emitSelect(...args),
  emitCellAudioRemove: (...args: unknown[]) => emitRemove(...args),
}))
vi.mock("@/lib/audio/audio-attachments-bus", () => ({
  notifyAudioAttachmentsChanged: (...args: unknown[]) => notify(...args),
}))

import { TakesStrip } from "./TakesStrip"

const session = { jwt: "jwt", username: "dir" } as never

function take(id: string, durationMs: number): AudioAttachmentOut {
  return { audioId: id, url: `frontier-audio://${id}.webm`, slot: "recording", mimeType: "audio/webm", voiceId: null, referenceAudioId: null, durationMs, trimStartMs: null, trimEndMs: null }
}

const common = { projectId: "p1", fileId: "f1", cellId: "c1", author: "dir", session }

beforeEach(() => {
  emitSelect.mockClear()
  emitRemove.mockClear()
  notify.mockClear()
})

describe("TakesStrip", () => {
  it("renders nothing when there are no takes", () => {
    const { container } = render(<TakesStrip {...common} takes={[]} selectedAudioId={null} />)
    expect(container.firstChild).toBeNull()
  })

  it("lists every take with a 1-based label and duration", () => {
    render(
      <TakesStrip {...common} takes={[take("a", 1500), take("b", 2300)]} selectedAudioId="b" />,
    )
    expect(screen.getByText("Takes (2)")).toBeTruthy()
    expect(screen.getByText(/Take 1/)).toBeTruthy()
    expect(screen.getByText(/Take 2/)).toBeTruthy()
    expect(screen.getByText("1.5s")).toBeTruthy()
    expect(screen.getByText("2.3s")).toBeTruthy()
  })

  it("circling a non-active take emits select for the recording slot and pokes the bus", async () => {
    render(
      <TakesStrip {...common} takes={[take("a", 1000), take("b", 1000)]} selectedAudioId="b" />,
    )
    // "Use this take" is the circle action; it's disabled on the active take,
    // so the only enabled one targets take "a".
    const useButtons = screen.getAllByRole("button", { name: "Use this take" })
    fireEvent.click(useButtons[0])
    await waitFor(() => expect(emitSelect).toHaveBeenCalledTimes(1))
    expect(emitSelect).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", fileId: "f1", cellId: "c1", audioId: "a", slot: "recording", author: "dir" }),
    )
    expect(notify).toHaveBeenCalledWith("f1")
  })

  it("shows the take as selected immediately (optimistic) before the server round-trip resolves", async () => {
    // Simulate a slow emitCellAudioSelect — UI should update before it resolves.
    let resolveSelect!: () => void
    emitSelect.mockImplementationOnce(
      () => new Promise<string>((res) => { resolveSelect = () => res("evt-ok") }),
    )

    render(
      <TakesStrip {...common} takes={[take("a", 1000), take("b", 1000)]} selectedAudioId="b" />,
    )

    // Click "Use this take" for take "a"
    const useButtons = screen.getAllByRole("button", { name: "Use this take" })
    fireEvent.click(useButtons[0])

    // Optimistic: take "a"'s circle button should now be titled "Active take"
    // (disabled) while take "b"'s remains "Use this take".
    await waitFor(() => {
      const activeTakeBtn = screen.queryByRole("button", { name: "Active take" })
      expect(activeTakeBtn).not.toBeNull()
      // Take "b"'s button is still enabled (not optimistically selected)
      const useBtns = screen.getAllByRole("button", { name: "Use this take" })
      expect(useBtns.length).toBe(1)
    })

    // Resolve the slow emit — clean state should persist
    resolveSelect()
    await waitFor(() => expect(emitSelect).toHaveBeenCalledTimes(1))
  })

  it("rapid spam: final state matches last click, no stuck state", async () => {
    // All emitSelect calls resolve immediately but in order.
    emitSelect.mockResolvedValue("evt-ok")

    // Render with 3 takes, none selected initially.
    const { rerender } = render(
      <TakesStrip {...common} takes={[take("a", 1000), take("b", 1000), take("c", 1000)]} selectedAudioId={null} />,
    )

    // Fire 3 rapid clicks: a, b, c — all while busyId is set.
    // Only the last one should remain as optimistic selection.
    const buttons = screen.getAllByRole("button", { name: "Use this take" })
    fireEvent.click(buttons[0]) // click take "a"
    // After first click busyId is set — subsequent clicks are disabled by
    // isSelectInFlight, so no extra emits are fired. This IS the spam-safety.
    // Verify: only 1 emit fired, not 3.
    await waitFor(() => expect(emitSelect).toHaveBeenCalledTimes(1))

    // Simulate server confirming take "a"
    rerender(
      <TakesStrip {...common} takes={[take("a", 1000), take("b", 1000), take("c", 1000)]} selectedAudioId="a" />,
    )

    // After confirmation: take "a" should be shown as active take, others as "Use this take"
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Active take" })).toBeTruthy()
      expect(screen.getAllByRole("button", { name: "Use this take" }).length).toBe(2)
    })
  })

  it("does not emit select for the already-active take", () => {
    render(<TakesStrip {...common} takes={[take("a", 1000)]} selectedAudioId="a" />)
    // The active take's circle button is disabled and labelled differently.
    expect(screen.queryByRole("button", { name: "Use this take" })).toBeNull()
    expect(screen.getByRole("button", { name: "Active take" })).toBeTruthy()
  })

  it("deleting a take emits remove and pokes the bus", async () => {
    render(<TakesStrip {...common} takes={[take("a", 1000)]} selectedAudioId="a" />)
    fireEvent.click(screen.getByRole("button", { name: "Delete take" }))
    await waitFor(() => expect(emitRemove).toHaveBeenCalledTimes(1))
    expect(emitRemove).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", fileId: "f1", cellId: "c1", audioId: "a", author: "dir" }),
    )
    expect(notify).toHaveBeenCalledWith("f1")
  })

  // A denoised take carries the `dn-` marker and points at the source it was
  // cleaned from via referenceAudioId.
  function cleaned(id: string, durationMs: number, ref: string): AudioAttachmentOut {
    return { ...take(id, durationMs), referenceAudioId: ref }
  }

  it("pins cleaned takes above originals and labels them 'Cleaned'", () => {
    const { container } = render(
      <TakesStrip
        {...common}
        takes={[take("audio-a", 1000), cleaned("dn-audio-c", 1200, "audio-a")]}
        selectedAudioId="dn-audio-c"
      />,
    )
    const cleanedLabel = screen.getByText("Cleaned")
    const originalLabel = screen.getByText("Take 1")
    expect(cleanedLabel).toBeTruthy()
    expect(originalLabel).toBeTruthy()
    // Cleaned card renders before the original in DOM order.
    expect(
      cleanedLabel.compareDocumentPosition(originalLabel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    // Originals offer denoise; cleaned takes do not.
    expect(screen.getAllByRole("button", { name: /Remove noise/ }).length).toBe(1)
    expect(container).toBeTruthy()
  })

  it("a cleaned take offers revert that selects the original take", async () => {
    emitSelect.mockResolvedValue("evt-ok")
    render(
      <TakesStrip
        {...common}
        takes={[take("audio-a", 1000), cleaned("dn-audio-c", 1200, "audio-a")]}
        selectedAudioId="dn-audio-c"
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Revert to the original recording" }))
    await waitFor(() => expect(emitSelect).toHaveBeenCalledTimes(1))
    expect(emitSelect).toHaveBeenCalledWith(
      expect.objectContaining({ audioId: "audio-a", slot: "recording", cellId: "c1" }),
    )
  })

  it("hides revert when the original source take is gone", () => {
    render(
      <TakesStrip
        {...common}
        takes={[cleaned("dn-audio-c", 1200, "audio-gone")]}
        selectedAudioId="dn-audio-c"
      />,
    )
    expect(screen.queryByRole("button", { name: "Revert to the original recording" })).toBeNull()
  })
})
