// SUB-48: the optimistic overlay's lifetime is anchored to the OUTBOX, not a
// wall clock. Sam recorded three takes; the flusher was in backoff and the
// events sat queued ~3 minutes, so the old 30s TTL expired first and the takes
// vanished off the timeline while they were perfectly safe on disk — then
// reappeared minutes later. Deletes had the mirror problem: no overlay at all,
// so a removed take lingered ("it won't delete") and a still-queued attach
// could paint it straight back.
//
// The contract these tests pin down:
//   • queued in the outbox  → the overlay is authoritative, forever
//   • left the outbox       → a short grace window, then server truth wins
//   • quarantined (failed)  → stop asserting it immediately
//   • emit rejected         → drop it and re-read
//   • deletes               → first-class overlay that cancels a pending attach

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import type { AudioAttachmentOut, CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import type { CellData } from "@/hooks/useCells"

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

// A fake outbox: id → status. Absent id = the event has left the queue.
const outbox = vi.hoisted(() => ({
  rows: new Map<string, "pending" | "failed">(),
  subscribers: new Set<() => void>(),
}))
vi.mock("@/lib/sync/outbox", () => ({
  getOutboxRecords: async (ids: readonly string[]) =>
    ids.filter((id) => outbox.rows.has(id)).map((id) => ({ id, status: outbox.rows.get(id) })),
  subscribeToOutbox: (cb: () => void) => {
    outbox.subscribers.add(cb)
    return () => outbox.subscribers.delete(cb)
  },
}))

import { useFileAudioAttachments, mergeCellsWithAudio } from "./useFileAudioAttachments"
import {
  SETTLED_GRACE_MS,
  UNBOUND_TTL_MS,
  clearOptimisticShadows,
  injectOptimisticAudioAttachment,
  injectOptimisticAudioRemove,
} from "@/lib/audio/audio-attachments-bus"

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

const cells = (entry: Partial<CellAudioEntry>): { cells: Record<string, CellAudioEntry> } => ({
  cells: {
    c1: {
      attachments: {},
      selectedAudioId: null,
      selectedGeneratedVoiceAudioId: null,
      audioTimings: {},
      ...entry,
    },
  },
})

/** Server payload where the LONG take is attached + selected. */
const serverLongSelected = () =>
  cells({ attachments: { [LONG.audioId]: LONG, [SHORT.audioId]: SHORT }, selectedAudioId: LONG.audioId })
/** Server payload after a select of SHORT projected. */
const serverShortSelected = () =>
  cells({ attachments: { [LONG.audioId]: LONG, [SHORT.audioId]: SHORT }, selectedAudioId: SHORT.audioId })
/** Server payload that knows nothing yet (pre-projection). */
const serverEmpty = () => cells({})

const queued = (id: string) => outbox.rows.set(id, "pending")
const delivered = (id: string) => outbox.rows.delete(id)
const quarantined = (id: string) => outbox.rows.set(id, "failed")

function mount() {
  return renderHook(() => useFileAudioAttachments("p1", "f1"))
}
const entryOf = (r: ReturnType<typeof mount>["result"]) => r.current.byCellId.get("c1")

beforeEach(() => {
  fetchMock.mockReset()
  outbox.rows.clear()
  outbox.subscribers.clear()
  clearOptimisticShadows("f1")
})
afterEach(() => {
  vi.useRealTimers()
})

describe("optimistic overlay — outbox-anchored lifetime (SUB-48)", () => {
  it("survives indefinitely while its event is still queued (Sam's 3-minute stall)", async () => {
    vi.useFakeTimers()
    try {
      fetchMock.mockResolvedValue(serverEmpty())
      const { result } = mount()
      await vi.waitFor(() => expect(result.current.byCellId.size).toBe(1))

      queued("evt-attach")
      act(() => injectOptimisticAudioAttachment("f1", "c1", SHORT, "evt-attach"))
      expect(entryOf(result)?.selectedAudioId).toBe(SHORT.audioId)

      // Five minutes of the flusher sitting in backoff, with refetches all the
      // way through. The take must still be on screen — and visibly saving.
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(30_000)
        await act(async () => {
          await result.current.revalidate()
        })
      }
      expect(entryOf(result)?.selectedAudioId).toBe(SHORT.audioId)
      expect(entryOf(result)?.attachments[SHORT.audioId]?.pendingSync).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("yields to the server a grace window after the event LEAVES the outbox", async () => {
    vi.useFakeTimers()
    try {
      fetchMock.mockResolvedValue(serverLongSelected())
      const { result } = mount()
      await vi.waitFor(() => expect(result.current.byCellId.size).toBe(1))

      queued("evt-select")
      act(() => injectOptimisticAudioAttachment("f1", "c1", SHORT, "evt-select"))

      // Delivered, but the read still shows the old selection (projection lag).
      delivered("evt-select")
      await act(async () => {
        await result.current.revalidate()
      })
      expect(entryOf(result)?.selectedAudioId).toBe(SHORT.audioId) // inside grace
      // …and it is no longer advertised as saving, because it has been sent.
      expect(entryOf(result)?.attachments[SHORT.audioId]?.pendingSync).toBeUndefined()

      vi.advanceTimersByTime(SETTLED_GRACE_MS + 1_000)
      await act(async () => {
        await result.current.revalidate()
      })
      expect(entryOf(result)?.selectedAudioId).toBe(LONG.audioId)
    } finally {
      vi.useRealTimers()
    }
  })

  it("the grace clock starts when the departure is OBSERVED, not at inject time", async () => {
    vi.useFakeTimers()
    try {
      fetchMock.mockResolvedValue(serverLongSelected())
      const { result } = mount()
      await vi.waitFor(() => expect(result.current.byCellId.size).toBe(1))

      queued("evt-select")
      act(() => injectOptimisticAudioAttachment("f1", "c1", SHORT, "evt-select"))

      // A full minute queued — far past any old TTL.
      vi.advanceTimersByTime(60_000)
      await act(async () => {
        await result.current.revalidate()
      })
      expect(entryOf(result)?.selectedAudioId).toBe(SHORT.audioId)

      // Now it lands; the grace window begins HERE, not 60s ago.
      delivered("evt-select")
      await act(async () => {
        await result.current.revalidate()
      })
      vi.advanceTimersByTime(SETTLED_GRACE_MS - 2_000)
      await act(async () => {
        await result.current.revalidate()
      })
      expect(entryOf(result)?.selectedAudioId).toBe(SHORT.audioId)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a quarantined event stops the overlay at once — the UI must not keep lying", async () => {
    fetchMock.mockResolvedValue(serverLongSelected())
    const { result } = mount()
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))

    queued("evt-select")
    act(() => injectOptimisticAudioAttachment("f1", "c1", SHORT, "evt-select"))
    quarantined("evt-select") // exceeded its attempts; will not send unaided
    await act(async () => {
      await result.current.revalidate()
    })
    expect(entryOf(result)?.selectedAudioId).toBe(LONG.audioId)
  })

  it("binds a late event id from the emit promise (paint-first callers)", async () => {
    fetchMock.mockResolvedValue(serverLongSelected())
    const { result } = mount()
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))

    let resolveEmit!: (id: string) => void
    const emitP = new Promise<string>((res) => { resolveEmit = res })
    act(() => injectOptimisticAudioAttachment("f1", "c1", SHORT, emitP))
    expect(entryOf(result)?.selectedAudioId).toBe(SHORT.audioId) // painted already

    queued("evt-late")
    await act(async () => {
      resolveEmit("evt-late")
      await emitP
    })
    // Bound and queued → survives a stale read that knows nothing about it.
    await act(async () => {
      await result.current.revalidate()
    })
    expect(entryOf(result)?.selectedAudioId).toBe(SHORT.audioId)
  })

  it("a REJECTED emit drops the overlay and re-reads (the change never happened)", async () => {
    fetchMock.mockResolvedValue(serverLongSelected())
    const { result } = mount()
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))

    const emitP = Promise.reject(new Error("no permission"))
    act(() => injectOptimisticAudioAttachment("f1", "c1", SHORT, emitP))
    expect(entryOf(result)?.selectedAudioId).toBe(SHORT.audioId)

    await act(async () => {
      await emitP.catch(() => {})
      await Promise.resolve()
    })
    await waitFor(() => expect(entryOf(result)?.selectedAudioId).toBe(LONG.audioId))
  })

  it("an overlay that never learns an event id expires on the unbound bound", async () => {
    vi.useFakeTimers()
    try {
      fetchMock.mockResolvedValue(serverLongSelected())
      const { result } = mount()
      await vi.waitFor(() => expect(result.current.byCellId.size).toBe(1))

      act(() => injectOptimisticAudioAttachment("f1", "c1", SHORT)) // no id at all
      vi.advanceTimersByTime(UNBOUND_TTL_MS + 1_000)
      await act(async () => {
        await result.current.revalidate()
      })
      expect(entryOf(result)?.selectedAudioId).toBe(LONG.audioId)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("optimistic overlay — deletes (SUB-48)", () => {
  it("hides the clip and empties the slot, promoting nothing (mirrors the projection)", async () => {
    fetchMock.mockResolvedValue(serverLongSelected())
    const { result } = mount()
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))

    queued("evt-remove")
    act(() => injectOptimisticAudioRemove("f1", "c1", LONG.audioId, "recording", "evt-remove"))
    const entry = entryOf(result)
    expect(entry?.attachments[LONG.audioId]).toBeUndefined()
    expect(entry?.selectedAudioId).toBeNull()
    // The OTHER take is untouched — deleting one clip never reshuffles the rest.
    expect(entry?.attachments[SHORT.audioId]).toBeDefined()
  })

  it("stays hidden across stale reads while the remove is queued (no 'it won't delete')", async () => {
    fetchMock.mockResolvedValue(serverLongSelected()) // server still has it
    const { result } = mount()
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))

    queued("evt-remove")
    act(() => injectOptimisticAudioRemove("f1", "c1", LONG.audioId, "recording", "evt-remove"))
    await act(async () => {
      await result.current.revalidate()
    })
    expect(entryOf(result)?.attachments[LONG.audioId]).toBeUndefined()
  })

  it("cancels a still-queued attach for the same clip (a just-recorded take can't resurrect)", async () => {
    fetchMock.mockResolvedValue(serverEmpty())
    const { result } = mount()
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))

    queued("evt-attach")
    act(() => injectOptimisticAudioAttachment("f1", "c1", SHORT, "evt-attach"))
    expect(entryOf(result)?.attachments[SHORT.audioId]).toBeDefined()

    queued("evt-remove")
    act(() => injectOptimisticAudioRemove("f1", "c1", SHORT.audioId, "recording", "evt-remove"))
    // Even though the attach is STILL queued, the take is gone and stays gone.
    await act(async () => {
      await result.current.revalidate()
    })
    expect(entryOf(result)?.attachments[SHORT.audioId]).toBeUndefined()
    expect(entryOf(result)?.selectedAudioId).toBeNull()
  })

  it("delete-then-rerecord replays in order — the new take wins", async () => {
    fetchMock.mockResolvedValue(serverLongSelected())
    const { result } = mount()
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))

    queued("evt-remove")
    act(() => injectOptimisticAudioRemove("f1", "c1", LONG.audioId, "recording", "evt-remove"))
    queued("evt-attach")
    act(() => injectOptimisticAudioAttachment("f1", "c1", SHORT, "evt-attach"))

    await act(async () => {
      await result.current.revalidate()
    })
    const entry = entryOf(result)
    expect(entry?.attachments[LONG.audioId]).toBeUndefined()
    expect(entry?.selectedAudioId).toBe(SHORT.audioId)
  })

  it("drops itself once the server read no longer carries the clip", async () => {
    fetchMock.mockResolvedValue(serverLongSelected())
    const { result } = mount()
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))

    queued("evt-remove")
    act(() => injectOptimisticAudioRemove("f1", "c1", LONG.audioId, "recording", "evt-remove"))
    // Delivered AND projected: the read stops returning it.
    delivered("evt-remove")
    fetchMock.mockResolvedValue(cells({ attachments: { [SHORT.audioId]: SHORT }, selectedAudioId: null }))
    await act(async () => {
      await result.current.revalidate()
    })
    // Server truth now drives; a later read that (wrongly) returned it again
    // would show it, proving the overlay is no longer pinned.
    fetchMock.mockResolvedValue(serverLongSelected())
    await act(async () => {
      await result.current.revalidate()
    })
    expect(entryOf(result)?.attachments[LONG.audioId]).toBeDefined()
  })
})

describe("optimistic overlay — selection and duration correctness", () => {
  it("a stale refetch does not revert an injected take selection (the original chip-revert bug)", async () => {
    fetchMock.mockResolvedValue(serverLongSelected())
    const { result } = mount()
    await waitFor(() => expect(entryOf(result)?.selectedAudioId).toBe(LONG.audioId))

    queued("evt-select")
    act(() => injectOptimisticAudioAttachment("f1", "c1", SHORT, "evt-select"))
    await act(async () => {
      await result.current.revalidate()
    })
    expect(entryOf(result)?.selectedAudioId).toBe(SHORT.audioId)
    expect(entryOf(result)?.attachments[SHORT.audioId]?.durationMs).toBe(2000)
  })

  it("a superseded select never resurrects once the newer one confirms (A→B)", async () => {
    fetchMock.mockResolvedValue(serverShortSelected())
    const { result } = mount()
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))

    queued("evt-a")
    act(() => injectOptimisticAudioAttachment("f1", "c1", LONG, "evt-a"))
    queued("evt-b")
    act(() => injectOptimisticAudioAttachment("f1", "c1", SHORT, "evt-b"))
    expect(entryOf(result)?.selectedAudioId).toBe(SHORT.audioId)

    delivered("evt-a")
    delivered("evt-b")
    await act(async () => {
      await result.current.revalidate()
    })
    await act(async () => {
      await result.current.revalidate()
    })
    expect(entryOf(result)?.selectedAudioId).toBe(SHORT.audioId)
  })

  it("a duration-bearing overlay is NOT confirmed by a server row that still lacks it", async () => {
    // The heal path: re-attach a legacy take with its decoded length. If the
    // read (pre-projection) confirmed the overlay, the chip would snap back to
    // fallback width — exactly the bug this whole slice exists to kill.
    const healed = { ...LONG, durationMs: 6000 }
    fetchMock.mockResolvedValue(
      cells({ attachments: { [LONG.audioId]: { ...LONG, durationMs: null } }, selectedAudioId: LONG.audioId }),
    )
    const { result } = mount()
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))

    delivered("evt-heal") // already sent; only the grace window protects it
    act(() => injectOptimisticAudioAttachment("f1", "c1", healed, "evt-heal"))
    await act(async () => {
      await result.current.revalidate()
    })
    expect(entryOf(result)?.attachments[LONG.audioId]?.durationMs).toBe(6000)
  })

  it("generatedVoice overlays confirm against the generated slot, leaving the recording slot alone", async () => {
    const GEN: AudioAttachmentOut = { ...SHORT, audioId: "audio-c1-300-gen.wav", slot: "generatedVoice" }
    fetchMock.mockResolvedValue(serverLongSelected())
    const { result } = mount()
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))

    queued("evt-gen")
    act(() => injectOptimisticAudioAttachment("f1", "c1", GEN, "evt-gen"))
    await act(async () => {
      await result.current.revalidate()
    })
    expect(entryOf(result)?.selectedGeneratedVoiceAudioId).toBe(GEN.audioId)
    expect(entryOf(result)?.selectedAudioId).toBe(LONG.audioId)
  })

  it("trim overlays only confirm when the server carries the same trims", async () => {
    const TRIMMED: AudioAttachmentOut = { ...LONG, trimStartMs: 500, trimEndMs: 4000 }
    fetchMock.mockResolvedValue(serverLongSelected()) // server has null trims
    const { result } = mount()
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))

    queued("evt-trim")
    act(() => injectOptimisticAudioAttachment("f1", "c1", TRIMMED, "evt-trim"))
    await act(async () => {
      await result.current.revalidate()
    })
    expect(entryOf(result)?.attachments[LONG.audioId]?.trimEndMs).toBe(4000)
  })

  it("a reader mounted AFTER the inject still sees it on its first read", async () => {
    // The recording modal opens right after an upload: the inject fired before
    // this hook existed, and its first fetch reads pre-projection state.
    queued("evt-attach")
    injectOptimisticAudioAttachment("f1", "c1", SHORT, "evt-attach")
    fetchMock.mockResolvedValue(serverLongSelected())
    const { result } = mount()
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))
    expect(entryOf(result)?.selectedAudioId).toBe(SHORT.audioId)
  })
})

describe("optimistic overlay — plumbing", () => {
  it("refetches when the outbox drains, but only while this file has live overlays", async () => {
    fetchMock.mockResolvedValue(serverLongSelected())
    const { result } = mount()
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))

    // Nothing of ours in flight → an outbox change is none of our business.
    const idle = fetchMock.mock.calls.length
    await act(async () => {
      outbox.subscribers.forEach((cb) => cb())
      await new Promise((r) => setTimeout(r, 400))
    })
    expect(fetchMock.mock.calls.length).toBe(idle)

    // With a live overlay, the same notification pulls fresh truth.
    queued("evt-select")
    act(() => injectOptimisticAudioAttachment("f1", "c1", SHORT, "evt-select"))
    const before = fetchMock.mock.calls.length
    await act(async () => {
      outbox.subscribers.forEach((cb) => cb())
      await new Promise((r) => setTimeout(r, 400))
    })
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before)
  })

  it("mergeCellsWithAudio carries pendingSync onto the cell attachment", () => {
    const base = [{ id: "c1", fileId: "f1", attachments: {} } as unknown as CellData]
    const withPending = new Map<string, CellAudioEntry>([
      ["c1", {
        attachments: { [SHORT.audioId]: { ...SHORT, pendingSync: true } },
        selectedAudioId: SHORT.audioId,
        selectedGeneratedVoiceAudioId: null,
        audioTimings: {},
      }],
    ])
    expect(mergeCellsWithAudio(base, withPending)[0].attachments?.[SHORT.audioId]?.pendingSync).toBe(true)

    const synced = new Map<string, CellAudioEntry>([
      ["c1", {
        attachments: { [SHORT.audioId]: SHORT },
        selectedAudioId: SHORT.audioId,
        selectedGeneratedVoiceAudioId: null,
        audioTimings: {},
      }],
    ])
    expect(mergeCellsWithAudio(base, synced)[0].attachments?.[SHORT.audioId]?.pendingSync).toBeUndefined()
  })
})
