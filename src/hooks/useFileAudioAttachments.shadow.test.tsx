// Round 8 (SUB-39 root fix): optimistic injections must SURVIVE a stale
// refetch. The outbox flusher posts on a ~5s timer, so a fetch poked right
// after an emit reads pre-projection server state — the shadow layer
// re-applies unconfirmed injections over every fetch until the server
// confirms them (or a 30s TTL expires).

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

import { useFileAudioAttachments } from "./useFileAudioAttachments"
import { clearOptimisticShadows, injectOptimisticAudioAttachment } from "@/lib/audio/audio-attachments-bus"

const LONG: AudioAttachmentOut = {
  audioId: "audio-c1-100-long.webm", url: "frontier-audio://long", slot: "recording",
  mimeType: "audio/webm", voiceId: null, referenceAudioId: null,
  durationMs: 6000, trimStartMs: null, trimEndMs: null,
}
const SHORT: AudioAttachmentOut = {
  audioId: "audio-c1-200-short.webm", url: "frontier-audio://short", slot: "recording",
  mimeType: "audio/webm", voiceId: null, referenceAudioId: null,
  durationMs: 2000, trimStartMs: null, trimEndMs: null,
}

/** Server payload where the LONG take is attached + selected. */
const serverLongSelected = (): { cells: Record<string, CellAudioEntry> } => ({
  cells: {
    c1: {
      attachments: { [LONG.audioId]: LONG, [SHORT.audioId]: SHORT },
      selectedAudioId: LONG.audioId,
      selectedGeneratedVoiceAudioId: null,
      audioTimings: {},
    },
  },
})

/** Server payload after the select PROJECTED (short selected). */
const serverShortSelected = (): { cells: Record<string, CellAudioEntry> } => ({
  cells: {
    c1: {
      attachments: { [LONG.audioId]: LONG, [SHORT.audioId]: SHORT },
      selectedAudioId: SHORT.audioId,
      selectedGeneratedVoiceAudioId: null,
      audioTimings: {},
    },
  },
})

describe("useFileAudioAttachments — optimistic shadows (round 8)", () => {
  beforeEach(() => {
    fetchMock.mockReset()
    clearOptimisticShadows("f1") // the registry is module-level (round 8d)
  })

  it("a reader mounted AFTER the inject still sees the shadow on its first fetch (round 8d)", async () => {
    // The recording modal opened right after an upload: the inject fired
    // before its hook existed, and its first fetch reads pre-flush state.
    act(() => injectOptimisticAudioAttachment("f1", "c1", SHORT))
    fetchMock.mockResolvedValue(serverLongSelected())
    const { result } = renderHook(() => useFileAudioAttachments("p1", "f1"))
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))
    expect(result.current.byCellId.get("c1")?.selectedAudioId).toBe(SHORT.audioId)
  })

  it("a STALE refetch does not revert an injected take selection (the chip-revert bug)", async () => {
    fetchMock.mockResolvedValue(serverLongSelected())
    const { result } = renderHook(() => useFileAudioAttachments("p1", "f1"))
    await waitFor(() => expect(result.current.byCellId.get("c1")?.selectedAudioId).toBe(LONG.audioId))

    // User clicks the SHORT take's checkmark → inject (the strip's wire).
    act(() => injectOptimisticAudioAttachment("f1", "c1", SHORT))
    expect(result.current.byCellId.get("c1")?.selectedAudioId).toBe(SHORT.audioId)

    // The premature notify triggers a refetch that still reads LONG-selected.
    await act(async () => {
      await result.current.revalidate()
    })
    // Round 8: the shadow survives — no revert.
    expect(result.current.byCellId.get("c1")?.selectedAudioId).toBe(SHORT.audioId)
    expect(result.current.byCellId.get("c1")?.attachments[SHORT.audioId]?.durationMs).toBe(2000)
  })

  it("a CONFIRMING fetch drops the shadow and server truth drives from then on", async () => {
    fetchMock.mockResolvedValue(serverLongSelected())
    const { result } = renderHook(() => useFileAudioAttachments("p1", "f1"))
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))

    act(() => injectOptimisticAudioAttachment("f1", "c1", SHORT))
    fetchMock.mockResolvedValue(serverShortSelected())
    await act(async () => {
      await result.current.revalidate()
    })
    expect(result.current.byCellId.get("c1")?.selectedAudioId).toBe(SHORT.audioId)

    // Shadow is gone: a later fetch showing a DIFFERENT server state wins.
    fetchMock.mockResolvedValue(serverLongSelected())
    await act(async () => {
      await result.current.revalidate()
    })
    expect(result.current.byCellId.get("c1")?.selectedAudioId).toBe(LONG.audioId)
  })

  it("an expired shadow (TTL) yields to the server", async () => {
    vi.useFakeTimers()
    try {
      fetchMock.mockResolvedValue(serverLongSelected())
      const { result } = renderHook(() => useFileAudioAttachments("p1", "f1"))
      await vi.waitFor(() => expect(result.current.byCellId.size).toBe(1))

      act(() => injectOptimisticAudioAttachment("f1", "c1", SHORT))
      vi.advanceTimersByTime(31_000)
      await act(async () => {
        await result.current.revalidate()
      })
      expect(result.current.byCellId.get("c1")?.selectedAudioId).toBe(LONG.audioId)
    } finally {
      vi.useRealTimers()
    }
  })

  it("generatedVoice-slot shadows confirm against selectedGeneratedVoiceAudioId", async () => {
    const GEN: AudioAttachmentOut = { ...SHORT, audioId: "audio-c1-300-gen.wav", slot: "generatedVoice" }
    fetchMock.mockResolvedValue(serverLongSelected())
    const { result } = renderHook(() => useFileAudioAttachments("p1", "f1"))
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))

    act(() => injectOptimisticAudioAttachment("f1", "c1", GEN))
    // Stale fetch: recording selection untouched, generated shadow survives.
    await act(async () => {
      await result.current.revalidate()
    })
    const entry = result.current.byCellId.get("c1")
    expect(entry?.selectedGeneratedVoiceAudioId).toBe(GEN.audioId)
    expect(entry?.selectedAudioId).toBe(LONG.audioId)
  })

  it("a SUPERSEDED select shadow never resurrects after the newer one confirms (A→B revert bug)", async () => {
    // Browser-verified failure mode: select LONG, then select SHORT. The
    // confirming fetch drops SHORT's shadow — but LONG's (unconfirmable: the
    // user superseded it) must not re-apply its selection claim.
    fetchMock.mockResolvedValue(serverShortSelected())
    const { result } = renderHook(() => useFileAudioAttachments("p1", "f1"))
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))

    act(() => injectOptimisticAudioAttachment("f1", "c1", LONG))
    act(() => injectOptimisticAudioAttachment("f1", "c1", SHORT))
    expect(result.current.byCellId.get("c1")?.selectedAudioId).toBe(SHORT.audioId)

    // Flusher posted both selects in order → server truth = SHORT selected.
    // SHORT's shadow confirms and drops; LONG's lingers but claims nothing.
    await act(async () => {
      await result.current.revalidate()
    })
    expect(result.current.byCellId.get("c1")?.selectedAudioId).toBe(SHORT.audioId)
    // And again (LONG's shadow must not become the slot's claimer once alone).
    await act(async () => {
      await result.current.revalidate()
    })
    expect(result.current.byCellId.get("c1")?.selectedAudioId).toBe(SHORT.audioId)
  })

  it("trim-bearing shadows only confirm when the server carries the same trims", async () => {
    const TRIMMED: AudioAttachmentOut = { ...LONG, trimStartMs: 500, trimEndMs: 4000 }
    fetchMock.mockResolvedValue(serverLongSelected()) // server has null trims
    const { result } = renderHook(() => useFileAudioAttachments("p1", "f1"))
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))

    act(() => injectOptimisticAudioAttachment("f1", "c1", TRIMMED))
    await act(async () => {
      await result.current.revalidate()
    })
    expect(result.current.byCellId.get("c1")?.attachments[LONG.audioId]?.trimEndMs).toBe(4000)
  })
})
