// AQU-2495 (review, Nov 12): the copy of a take painted while a Recording-tab
// trim saves holds only what the trim changes (its window), painted over the
// take as the server's read has it, and yields as soon as the read carries
// that window. A copy of the whole take stood in for it before: it hid a
// colleague's rename, move or volume change made meanwhile for up to 12 s, and
// swallowed your own volume change made while it lived.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import type { AudioAttachmentOut, CellAudioEntry } from "@/lib/sync/cell-audio-read-types"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "sam" }, loading: false }),
}))
vi.mock("@/lib/audio/sync-token-fetcher", () => ({
  makeAudioSyncTokenFetcher: () => async () => "sync-tok",
}))
const fetchMock = vi.fn()
vi.mock("@/lib/sync/cell-audio-read", () => ({
  fetchFileAudioAttachments: (...args: unknown[]) => fetchMock(...args),
}))
const outbox = vi.hoisted(() => ({ rows: new Map<string, "pending" | "failed">() }))
vi.mock("@/lib/sync/outbox", () => ({
  getOutboxRecords: async (ids: readonly string[]) =>
    ids.filter((id) => outbox.rows.has(id)).map((id) => ({ id, status: outbox.rows.get(id) })),
  subscribeToOutbox: () => () => {},
}))
vi.mock("@/lib/sync/events-emit", () => ({ emitCellAudioTrim: vi.fn(async () => "evt-trim") }))

import { useFileAudioAttachments } from "./useFileAudioAttachments"
import { clearOptimisticShadows, getOptimisticShadows, injectOptimisticAudioTrim } from "@/lib/audio/audio-attachments-bus"
import { persistTakeTrim } from "@/lib/audio/persist-trim"
import { attachmentOutFrom } from "@/lib/audio/cut-take"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"

const BED: AudioAttachmentOut = {
  audioId: "audio-c1-1700000000-bed.wav", url: "frontier-audio://bed", slot: "track-music",
  mimeType: "audio/wav", voiceId: null, referenceAudioId: null, durationMs: 20_000,
  label: "Music bed", trimStartMs: 4_000, trimEndMs: null, targetOffsetMs: -8_000, recordingsOffsetMs: null, gainDb: -3,
}
const read = (att: AudioAttachmentOut): { cells: Record<string, CellAudioEntry> } => ({
  cells: { c1: { attachments: { [att.audioId]: att }, selectedBySlot: { "track-music": att.audioId }, selectedAudioId: null, selectedGeneratedVoiceAudioId: null, audioTimings: {} } },
})
/** The take as the Recording tab hands it to the trim (the table's copy). */
const tableCopy = { type: "audio", ...BED } as unknown as CodexCellAttachment

function mount() {
  return renderHook(() => useFileAudioAttachments("p1", "f1"))
}
const bedOf = (r: ReturnType<typeof mount>["result"]) => r.current.byCellId.get("c1")?.attachments[BED.audioId]
const trimTo = (startMs: number) => persistTakeTrim({
  projectId: "p1", fileId: "f1", cellId: "c1", audioId: BED.audioId, att: tableCopy,
  trimStartMs: startMs, trimEndMs: null, author: "dev",
})

beforeEach(() => {
  fetchMock.mockReset()
  outbox.rows.clear()
  clearOptimisticShadows("f1")
})

describe("a Recording-tab trim's copy holds only its window (AQU-2495, Nov 12)", () => {
  it("a colleague's rename, move and volume change made while it saves show at once", async () => {
    fetchMock.mockResolvedValue(read(BED))
    const { result } = mount()
    await waitFor(() => expect(bedOf(result)).toBeDefined())
    outbox.rows.set("evt-trim", "pending")
    await act(async () => { await trimTo(3_500) })
    // The read has not got the trim yet, but has bob's changes.
    fetchMock.mockResolvedValue(read({ ...BED, label: "Bed (final)", targetOffsetMs: -7_000, gainDb: 2 }))
    await act(async () => { await result.current.revalidate() })
    expect(bedOf(result)).toMatchObject({ trimStartMs: 3_500, label: "Bed (final)", targetOffsetMs: -7_000, gainDb: 2 })
  })

  it("it yields as soon as the read carries its window, whatever else changed since", async () => {
    fetchMock.mockResolvedValue(read(BED))
    const { result } = mount()
    await waitFor(() => expect(bedOf(result)).toBeDefined())
    await act(async () => { await trimTo(3_500) })
    // The trim was delivered; the read has it, and a rename made since.
    fetchMock.mockResolvedValue(read({ ...BED, trimStartMs: 3_500, label: "Bed (final)" }))
    await act(async () => { await result.current.revalidate() })
    expect(getOptimisticShadows("f1").get("c1") ?? []).toEqual([])
    expect(bedOf(result)).toMatchObject({ trimStartMs: 3_500, label: "Bed (final)" })
  })

  it("your own volume change made while it saves shows at once", async () => {
    fetchMock.mockResolvedValue(read(BED))
    const { result } = mount()
    await waitFor(() => expect(bedOf(result)).toBeDefined())
    outbox.rows.set("evt-trim", "pending")
    outbox.rows.set("evt-gain", "pending")
    await act(async () => { await trimTo(3_500) })
    // The Station's volume line, as the workspace paints it (applyTakeGain).
    act(() => injectOptimisticAudioTrim("f1", "c1", { ...attachmentOutFrom(BED.audioId, { ...tableCopy, trimStartMs: 3_500 }, BED.slot), gainDb: -9 }, "evt-gain"))
    await act(async () => { await result.current.revalidate() })
    expect(bedOf(result)).toMatchObject({ trimStartMs: 3_500, gainDb: -9 })
  })
})
