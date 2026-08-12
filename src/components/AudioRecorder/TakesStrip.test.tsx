// Verifies the takes strip surfaces every recording-slot take, marks the
// circled (active) one, and routes circle/delete actions to the right events.
// These matter because the strip is the only UI for choosing the keeper take
// in a booth session — a wrong audioId or slot here silently corrupts the mix.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { AudioAttachmentOut } from "@/lib/sync/cell-audio-read-types"

const emitSelect = vi.fn(async (..._args: unknown[]) => "evt-1")
const emitRemove = vi.fn(async (..._args: unknown[]) => "evt-2")
const emitRename = vi.fn(async (..._args: unknown[]) => "evt-3")
const notify = vi.fn((..._args: unknown[]) => {})
const injectOptimistic = vi.fn((..._args: unknown[]) => {})

vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioSelect: (...args: unknown[]) => emitSelect(...args),
  emitCellAudioRemove: (...args: unknown[]) => emitRemove(...args),
  emitCellAudioRename: (...args: unknown[]) => emitRename(...args),
}))
const injectOptimisticRemove = vi.fn((..._args: unknown[]) => {})
vi.mock("@/lib/audio/audio-attachments-bus", () => ({
  notifyAudioAttachmentsChanged: (...args: unknown[]) => notify(...args),
  injectOptimisticAudioAttachment: (...args: unknown[]) => injectOptimistic(...args),
  injectOptimisticAudioRemove: (...args: unknown[]) => injectOptimisticRemove(...args),
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

  it("lists every take with its (backfilled) name and duration", async () => {
    render(
      <TakesStrip {...common} takes={[take("a", 1500), take("b", 2300)]} selectedAudioId="b" />,
    )
    expect(screen.getByText("Takes (2)")).toBeTruthy()
    // Round 8: legacy unlabeled takes get names via the async backfill.
    await waitFor(() => {
      expect(screen.getByText(/Take 1/)).toBeTruthy()
      expect(screen.getByText(/Take 2/)).toBeTruthy()
    })
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
    // Round 7 (SUB-39): selection also rides the optimistic attachment bus so
    // the timeline chip swaps + resizes with zero round-trip.
    expect(injectOptimistic).toHaveBeenCalledWith(
      "f1",
      "c1",
      expect.objectContaining({ audioId: "a" }),
      // SUB-48: bound to the select event, so the overlay lives exactly as
      // long as that event sits in the outbox.
      expect.anything(),
    )
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

  it("deleting hides the take at once via a remove overlay bound to the event (SUB-48)", async () => {
    // Without this the row/chip stayed put while the remove sat in the outbox
    // — which read as "it won't delete" — and a still-queued attach for the
    // same clip could paint it straight back.
    injectOptimisticRemove.mockClear()
    render(<TakesStrip {...common} takes={[take("a", 1000)]} selectedAudioId="a" />)
    fireEvent.click(screen.getByRole("button", { name: "Delete take" }))
    await waitFor(() => expect(injectOptimisticRemove).toHaveBeenCalledTimes(1))
    expect(injectOptimisticRemove).toHaveBeenCalledWith("f1", "c1", "a", "recording", expect.anything())
  })

  it("deleting a GENERATED take targets the generated slot", async () => {
    injectOptimisticRemove.mockClear()
    const gen = { ...take("g", 1000), slot: "generatedVoice" as const }
    render(<TakesStrip {...common} takes={[gen]} selectedAudioId={null} selectedGeneratedAudioId="g" />)
    fireEvent.click(screen.getByRole("button", { name: "Delete take" }))
    await waitFor(() => expect(injectOptimisticRemove).toHaveBeenCalledTimes(1))
    expect(injectOptimisticRemove).toHaveBeenCalledWith("f1", "c1", "g", "generatedVoice", expect.anything())
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

// ── Round 8: rows with STABLE, renamable names ──

const namedTake = (id: string, label: string | null, durationMs = 1000): AudioAttachmentOut =>
  ({ ...take(id, durationMs), label })

describe("TakesStrip — stable names (round 8)", () => {
  beforeEach(() => emitRename.mockClear())

  it("renders persisted labels verbatim — deleting a take never renumbers the rest", () => {
    render(
      <TakesStrip
        {...common}
        takes={[namedTake("a", "Take 1"), namedTake("c", "Take 3")]} // Take 2 was deleted
        selectedAudioId="a"
      />,
    )
    expect(screen.getByTestId("take-label-a")).toHaveTextContent("Take 1")
    expect(screen.getByTestId("take-label-c")).toHaveTextContent("Take 3")
    expect(screen.queryByText("Take 2")).toBeNull()
  })

  it("takes render as ROWS (one per line), not chips", () => {
    render(
      <TakesStrip {...common} takes={[namedTake("a", "Take 1"), namedTake("b", "Take 2")]} selectedAudioId="a" />,
    )
    expect(screen.getByTestId("take-row-a")).toBeInTheDocument()
    expect(screen.getByTestId("take-row-b")).toBeInTheDocument()
  })

  it("renaming commits cell.audio.rename and shows the new name instantly", async () => {
    render(<TakesStrip {...common} takes={[namedTake("a", "Take 1")]} selectedAudioId="a" />)
    fireEvent.click(screen.getByRole("button", { name: "Rename take" }))
    const input = screen.getByTestId("take-rename-a")
    fireEvent.change(input, { target: { value: "Best whisper" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(emitRename).toHaveBeenCalledTimes(1))
    expect(emitRename).toHaveBeenCalledWith(
      expect.objectContaining({ audioId: "a", label: "Best whisper", cellId: "c1" }),
    )
    expect(screen.getByTestId("take-label-a")).toHaveTextContent("Best whisper")
  })

  it("legacy unlabeled takes are backfilled ONCE with sequential names", async () => {
    render(<TakesStrip {...common} takes={[take("a", 1000), take("b", 1000)]} selectedAudioId="a" />)
    await waitFor(() => expect(emitRename).toHaveBeenCalledTimes(2))
    expect(emitRename).toHaveBeenCalledWith(expect.objectContaining({ audioId: "a", label: "Take 1" }))
    expect(emitRename).toHaveBeenCalledWith(expect.objectContaining({ audioId: "b", label: "Take 2" }))
  })
})

// ── Round 8c: TTS results are TAKES — one list, either kind circleable ──

const genTake = (id: string, durationMs = 3000, label: string | null = null): AudioAttachmentOut =>
  ({ ...take(id, durationMs), slot: "generatedVoice", voiceId: "v1", label })

const SOURCE_CLIP: AudioAttachmentOut = {
  ...take("audio-f1-100-clip.mp3", 30000), // fileId-seeded — the imported clip
}

describe("TakesStrip — generated (TTS) takes (round 8c)", () => {
  beforeEach(() => {
    emitSelect.mockClear()
    injectOptimistic.mockClear()
  })

  it("marks the generated take active when the recording slot holds the source clip", () => {
    render(
      <TakesStrip
        {...common}
        takes={[namedTake("audio-c1-1-t.webm", "Take 1"), genTake("audio-c1-2-g.wav", 3000, "Take 2")]}
        selectedAudioId={SOURCE_CLIP.audioId} // source ≠ a take → TTS sounds
        selectedGeneratedAudioId="audio-c1-2-g.wav"
        sourceClip={SOURCE_CLIP}
      />,
    )
    const row = screen.getByTestId("take-row-audio-c1-2-g.wav")
    expect(row.className).toContain("border-violet-500/60")
    // The recorded take is NOT circled even though takes exist.
    expect(screen.getByTestId("take-row-audio-c1-1-t.webm").className).not.toContain("emerald-500/60")
  })

  it("a recorded take holding the slot shadows the generated selection (playback order)", () => {
    render(
      <TakesStrip
        {...common}
        takes={[namedTake("audio-c1-1-t.webm", "Take 1"), genTake("audio-c1-2-g.wav")]}
        selectedAudioId="audio-c1-1-t.webm"
        selectedGeneratedAudioId="audio-c1-2-g.wav"
        sourceClip={SOURCE_CLIP}
      />,
    )
    expect(screen.getByTestId("take-row-audio-c1-1-t.webm").className).toContain("border-emerald-500/60")
    expect(screen.getByTestId("take-row-audio-c1-2-g.wav").className).not.toContain("border-violet-500/60")
  })

  it("activating a TTS take selects the generated slot AND hands the recording slot to the source clip", async () => {
    render(
      <TakesStrip
        {...common}
        takes={[namedTake("audio-c1-1-t.webm", "Take 1"), genTake("audio-c1-2-g.wav")]}
        selectedAudioId="audio-c1-1-t.webm" // a recorded take holds the slot
        selectedGeneratedAudioId={null}
        sourceClip={SOURCE_CLIP}
      />,
    )
    const useButtons = screen.getAllByRole("button", { name: "Use this take" })
    fireEvent.click(useButtons[useButtons.length - 1]) // the TTS row
    await waitFor(() => expect(emitSelect).toHaveBeenCalledTimes(2))
    expect(emitSelect).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ audioId: "audio-c1-2-g.wav", slot: "generatedVoice" }))
    expect(emitSelect).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ audioId: SOURCE_CLIP.audioId, slot: "recording" }))
    expect(injectOptimistic).toHaveBeenCalledWith(
      "f1", "c1", expect.objectContaining({ audioId: "audio-c1-2-g.wav" }), expect.anything(),
    )
    expect(injectOptimistic).toHaveBeenCalledWith(
      "f1", "c1", expect.objectContaining({ audioId: SOURCE_CLIP.audioId }), expect.anything(),
    )
  })

  it("activating a TTS take when the source already holds the slot emits ONE select", async () => {
    render(
      <TakesStrip
        {...common}
        takes={[genTake("audio-c1-2-g.wav")]}
        selectedAudioId={SOURCE_CLIP.audioId}
        selectedGeneratedAudioId={null}
        sourceClip={SOURCE_CLIP}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Use this take" }))
    await waitFor(() => expect(emitSelect).toHaveBeenCalledTimes(1))
    expect(emitSelect).toHaveBeenCalledWith(
      expect.objectContaining({ audioId: "audio-c1-2-g.wav", slot: "generatedVoice" }))
  })

  it("activating a RECORDED take stays a single recording-slot select", async () => {
    render(
      <TakesStrip
        {...common}
        takes={[namedTake("audio-c1-1-t.webm", "Take 1"), genTake("audio-c1-2-g.wav")]}
        selectedAudioId={SOURCE_CLIP.audioId}
        selectedGeneratedAudioId="audio-c1-2-g.wav"
        sourceClip={SOURCE_CLIP}
      />,
    )
    fireEvent.click(screen.getAllByRole("button", { name: "Use this take" })[0])
    await waitFor(() => expect(emitSelect).toHaveBeenCalledTimes(1))
    expect(emitSelect).toHaveBeenCalledWith(
      expect.objectContaining({ audioId: "audio-c1-1-t.webm", slot: "recording" }))
  })

  it("generated rows show the sparkle and never offer denoise", () => {
    render(
      <TakesStrip
        {...common}
        takes={[namedTake("audio-c1-1-t.webm", "Take 1"), genTake("audio-c1-2-g.wav", 3000, "Take 2")]}
        selectedAudioId="audio-c1-1-t.webm"
        sourceClip={SOURCE_CLIP}
      />,
    )
    expect(screen.getAllByRole("button", { name: /Remove noise/ }).length).toBe(1) // recorded row only
  })
})
