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
//   • quarantined (failed)  → keep the ATTACHMENT (badged, AQU-924) but drop the
//                             SELECTION claim, which the server never agreed to
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
  notifyAudioAttachmentsChanged,
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

  it("overlays settling at DIFFERENT times each expire on their own deadline, unpoked", async () => {
    // Adversarial review caught this: arming the sweep only on a fresh
    // transition meant two overlays settling seconds apart shared one timer,
    // and the fetch it triggered saw no new transition — so the younger one
    // had nothing left to prune it (the outbox subscription is closed once
    // everything is settled). It would have shown a phantom take indefinitely.
    vi.useFakeTimers()
    try {
      const GEN: AudioAttachmentOut = { ...SHORT, audioId: "audio-c1-300-gen.wav", slot: "generatedVoice" }
      fetchMock.mockResolvedValue(serverLongSelected()) // confirms neither overlay
      const { result } = mount()
      await vi.waitFor(() => expect(result.current.byCellId.size).toBe(1))

      queued("evt-short")
      queued("evt-gen")
      act(() => injectOptimisticAudioAttachment("f1", "c1", SHORT, "evt-short"))
      act(() => injectOptimisticAudioAttachment("f1", "c1", GEN, "evt-gen"))

      delivered("evt-short")
      await act(async () => {
        await result.current.revalidate()
      })
      // …the second one lands five seconds later.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000)
      })
      delivered("evt-gen")
      await act(async () => {
        await result.current.revalidate()
      })
      expect(entryOf(result)?.selectedGeneratedVoiceAudioId).toBe(GEN.audioId)

      // From here on, NOTHING pokes the hook: no user action, no outbox
      // change, no manual revalidate. Both must still fall away on time.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SETTLED_GRACE_MS + 2_000)
      })
      expect(entryOf(result)?.selectedAudioId).toBe(LONG.audioId) // first swept
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SETTLED_GRACE_MS + 2_000)
      })
      expect(entryOf(result)?.selectedGeneratedVoiceAudioId).toBeNull() // second too
    } finally {
      vi.useRealTimers()
    }
  })

  it("a quarantined event stops claiming SELECTION at once — the UI must not keep lying", async () => {
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

  // ── AQU-924 ───────────────────────────────────────────────────────────────
  // Joy uploaded audio to a batch of verses; the bar read "36 failed"; on
  // refresh some verses were back to "Click a voice to generate" with no
  // waveform, no error and nothing to retry — while the clips' bytes sat in R2
  // and their attach events sat undelivered in this very outbox. The overlay was
  // dropped the instant a record was quarantined, so the ONLY surviving record
  // that the take existed was thrown away. A failed save must be visible.

  it("AQU-924: a quarantined ATTACH keeps the take visible, flagged syncFailed", async () => {
    // The server knows nothing about this cell — as it would for an upload whose
    // attach event never landed.
    fetchMock.mockResolvedValue(serverEmpty())
    const { result } = mount()
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))

    queued("evt-attach")
    act(() => injectOptimisticAudioAttachment("f1", "c1", SHORT, "evt-attach"))
    quarantined("evt-attach")
    await act(async () => {
      await result.current.revalidate()
    })

    const att = entryOf(result)?.attachments[SHORT.audioId]
    expect(att).toBeTruthy() // the take did NOT vanish
    expect(att?.syncFailed).toBe(true) // and it says why
    expect(att?.pendingSync).toBeUndefined() // not "saving" — it isn't coming
    // Honest about what the server has: nothing is selected/voiced.
    expect(entryOf(result)?.selectedAudioId).toBeNull()
  })

  it("AQU-924: the flag survives repeated reads — it is re-derived, never stored", async () => {
    fetchMock.mockResolvedValue(serverEmpty())
    const { result } = mount()
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))

    queued("evt-attach")
    act(() => injectOptimisticAudioAttachment("f1", "c1", SHORT, "evt-attach"))
    quarantined("evt-attach")
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await result.current.revalidate()
      })
      expect(entryOf(result)?.attachments[SHORT.audioId]?.syncFailed).toBe(true)
    }
  })

  it("AQU-924: a retry flips the take back to 'saving', and delivery clears it", async () => {
    fetchMock.mockResolvedValue(serverEmpty())
    const { result } = mount()
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))

    queued("evt-attach")
    act(() => injectOptimisticAudioAttachment("f1", "c1", SHORT, "evt-attach"))
    quarantined("evt-attach")
    await act(async () => {
      await result.current.revalidate()
    })
    expect(entryOf(result)?.attachments[SHORT.audioId]?.syncFailed).toBe(true)

    // The user hits Retry: the record goes back to pending.
    queued("evt-attach")
    await act(async () => {
      await result.current.revalidate()
    })
    let att = entryOf(result)?.attachments[SHORT.audioId]
    expect(att?.pendingSync).toBe(true)
    expect(att?.syncFailed).toBeUndefined()
    // Selection is claimed again now that the change is genuinely in flight.
    expect(entryOf(result)?.selectedAudioId).toBe(SHORT.audioId)

    // It lands: the server now has it and the overlay retires.
    fetchMock.mockResolvedValue(
      cells({ attachments: { [SHORT.audioId]: SHORT }, selectedAudioId: SHORT.audioId }),
    )
    delivered("evt-attach")
    await act(async () => {
      await result.current.revalidate()
    })
    att = entryOf(result)?.attachments[SHORT.audioId]
    expect(att?.syncFailed).toBeUndefined()
    expect(att?.pendingSync).toBeUndefined()
  })

  it("AQU-924: a quarantined REMOVE still yields — a failed delete must not keep hiding a live clip", async () => {
    fetchMock.mockResolvedValue(serverLongSelected())
    const { result } = mount()
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))

    queued("evt-remove")
    act(() => injectOptimisticAudioRemove("f1", "c1", LONG.audioId, "recording", "evt-remove"))
    expect(entryOf(result)?.attachments[LONG.audioId]).toBeUndefined() // hidden while queued

    quarantined("evt-remove")
    await act(async () => {
      await result.current.revalidate()
    })
    // The clip is still on the server, so it comes BACK — the honest signal that
    // the delete never happened. Nothing was at risk, so nothing is preserved.
    expect(entryOf(result)?.attachments[LONG.audioId]).toBeTruthy()
  })

  it("AQU-924: mergeCellsWithAudio forwards syncFailed to the cell attachment", async () => {
    fetchMock.mockResolvedValue(serverEmpty())
    const { result } = mount()
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))

    queued("evt-attach")
    act(() => injectOptimisticAudioAttachment("f1", "c1", SHORT, "evt-attach"))
    quarantined("evt-attach")
    await act(async () => {
      await result.current.revalidate()
    })

    const merged = mergeCellsWithAudio(
      [{ id: "c1" } as CellData],
      result.current.byCellId,
    )
    expect(merged[0].attachments?.[SHORT.audioId]?.syncFailed).toBe(true)
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

  // ── The review's blocker, from the confirmation side (2026-08-27) ─────────
  //
  // An upload to an ADDED track injected its shadow with a hard-coded
  // "recording" slot while the event carried the track's own. The mispaint was
  // the visible half; this is the half that made it stick. `shadowConfirmed`
  // looks the selection up BY SLOT, so a shadow claiming "recording" was
  // compared against the DEFAULT row's real take, never matched, and was never
  // confirmed — it survived to the settled-grace bound instead and then
  // vanished. The pair below is the generatedVoice case's missing sibling: an
  // added track's slot is a uuidv7, not one of the two legacy names.
  const TRACK_SLOT = "01a04395-3ed1-7c6b-9f2e-6d5a1c0b8e42"

  it("an added track's overlay confirms against ITS OWN slot, leaving the recording slot alone", async () => {
    const ON_TRACK: AudioAttachmentOut = { ...SHORT, audioId: "audio-c1-400-trk.wav", slot: TRACK_SLOT }
    // The server has projected the attach on the track's slot — the state the
    // shadow is supposed to recognise as "caught up".
    fetchMock.mockResolvedValue(cells({
      attachments: { [LONG.audioId]: LONG, [ON_TRACK.audioId]: ON_TRACK },
      selectedAudioId: LONG.audioId,
      selectedBySlot: { recording: LONG.audioId, [TRACK_SLOT]: ON_TRACK.audioId },
    }))
    const { result } = mount()
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))

    delivered("evt-trk") // out of the outbox: only confirmation can retire it now
    act(() => injectOptimisticAudioAttachment("f1", "c1", ON_TRACK, "evt-trk"))
    await act(async () => {
      await result.current.revalidate()
    })
    // The take is on its own track…
    expect(entryOf(result)?.selectedBySlot?.[TRACK_SLOT]).toBe(ON_TRACK.audioId)
    // …and the default dub row's selection was never touched. This is the
    // assertion the blocker failed: it moved LONG aside for the new upload.
    expect(entryOf(result)?.selectedAudioId).toBe(LONG.audioId)
    expect(entryOf(result)?.selectedBySlot?.recording).toBe(LONG.audioId)
  })

  it("an overlay on the wrong slot cannot confirm against the right one", async () => {
    // The blocker's shape, stated directly: the shadow says "recording", the
    // server projected the take onto the track. Confirmation must NOT be
    // fooled — and the default row's own take must win the recording slot.
    const MISLABELLED: AudioAttachmentOut = { ...SHORT, audioId: "audio-c1-400-trk.wav", slot: "recording" }
    fetchMock.mockResolvedValue(cells({
      attachments: { [LONG.audioId]: LONG },
      selectedAudioId: LONG.audioId,
      selectedBySlot: { recording: LONG.audioId, [TRACK_SLOT]: "audio-c1-400-trk.wav" },
    }))
    const { result } = mount()
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))

    queued("evt-bad")
    act(() => injectOptimisticAudioAttachment("f1", "c1", MISLABELLED, "evt-bad"))
    await act(async () => {
      await result.current.revalidate()
    })
    // While it is queued the overlay paints, and it paints on the WRONG row —
    // the default one — which is exactly what the user saw.
    expect(entryOf(result)?.selectedBySlot?.recording).toBe(MISLABELLED.audioId)
    // The server's own answer for the track is untouched by the bad shadow.
    expect(entryOf(result)?.selectedBySlot?.[TRACK_SLOT]).toBe("audio-c1-400-trk.wav")
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

// Pre-merge round: the measure batch paints with claimSelection:false, and it
// runs for minutes while the user keeps working. A metadata-only paint must
// therefore be NON-DESTRUCTIVE — it cannot resurrect a take the user just
// deleted, and it cannot demote a take they just selected.
describe("non-claiming optimistic paint (duration measure backfill)", () => {
  const measured = { ...SHORT, durationMs: 3210 }

  it("does NOT resurrect a take with a delete already pending", async () => {
    fetchMock.mockResolvedValue(serverLongSelected())
    const { result } = mount()
    await waitFor(() => expect(entryOf(result)?.attachments[SHORT.audioId]).toBeTruthy())

    queued("evt-remove")
    act(() => injectOptimisticAudioRemove("f1", "c1", SHORT.audioId, "recording", "evt-remove"))
    expect(entryOf(result)?.attachments[SHORT.audioId]).toBeUndefined()

    // The batch reaches this take: its bytes are still fetchable (the delete
    // is a soft one), so it measures and paints. The delete must win.
    queued("evt-measure")
    act(() =>
      injectOptimisticAudioAttachment("f1", "c1", measured, "evt-measure", { claimSelection: false }),
    )
    expect(entryOf(result)?.attachments[SHORT.audioId]).toBeUndefined()
  })

  it("does NOT steal the selection from a take picked mid-batch", async () => {
    fetchMock.mockResolvedValue(serverLongSelected())
    const { result } = mount()
    await waitFor(() => expect(entryOf(result)?.selectedAudioId).toBe(LONG.audioId))

    // The user picks SHORT while the batch runs.
    queued("evt-select")
    act(() => injectOptimisticAudioAttachment("f1", "c1", SHORT, "evt-select"))
    expect(entryOf(result)?.selectedAudioId).toBe(SHORT.audioId)

    // The batch measures that same take. It must keep the claim AND gain the
    // duration — a replacement shadow would have dropped the selection back
    // to the server's stale value.
    queued("evt-measure")
    act(() =>
      injectOptimisticAudioAttachment("f1", "c1", measured, "evt-measure", { claimSelection: false }),
    )
    // The damage only shows on the next READ: shadows are re-applied from the
    // server base in order, so a claim lost at inject time surfaces here. The
    // select is still queued, so its claim must still be governing.
    act(() => notifyAudioAttachmentsChanged("f1"))
    await waitFor(() => expect(entryOf(result)?.attachments[SHORT.audioId]?.durationMs).toBe(3210))
    expect(entryOf(result)?.selectedAudioId).toBe(SHORT.audioId)
  })

  it("keeps a mid-batch trim rather than repainting the pre-batch geometry", async () => {
    fetchMock.mockResolvedValue(serverLongSelected())
    const { result } = mount()
    await waitFor(() => expect(entryOf(result)?.attachments[SHORT.audioId]).toBeTruthy())

    queued("evt-trim")
    act(() =>
      injectOptimisticAudioAttachment("f1", "c1", { ...SHORT, trimStartMs: 500, trimEndMs: 1500 }, "evt-trim"),
    )
    queued("evt-measure")
    act(() =>
      injectOptimisticAudioAttachment("f1", "c1", measured, "evt-measure", { claimSelection: false }),
    )
    const painted = entryOf(result)?.attachments[SHORT.audioId]
    expect(painted?.trimStartMs).toBe(500)
    expect(painted?.trimEndMs).toBe(1500)
    expect(painted?.durationMs).toBe(3210)
  })
})
