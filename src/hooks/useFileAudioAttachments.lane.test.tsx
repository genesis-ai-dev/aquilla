// AQU-1978: a take still waiting to sync shows in ITS lane, not in every lane.
//
// The optimistic overlays were kept per file only, so a read of any lane
// painted every overlay on it: switch the editor from French to the default
// lane while a French take sat in the outbox and the default lane showed the
// French take as its own. After a reload the overlays rebuilt from the outbox
// did the same, ignoring the lane the queued event named.
//
// The overlay's lane is the lane its EVENT names — read off the outbox record
// it is bound to — with `''` (no tag) being an old project's default lane, and
// an import's shared programme audio belonging to every lane.

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

interface FakeRecord {
  status: "pending" | "failed"
  event: { kind: string; projectId: string; fileId: string; cellId: string; payload: Record<string, unknown> }
}
// A fake outbox: id → record. Absent id = the event has left the queue.
const outbox = vi.hoisted(() => ({
  rows: new Map<string, FakeRecord>(),
  subscribers: new Set<() => void>(),
}))
vi.mock("@/lib/sync/outbox", () => ({
  getOutboxRecords: async (ids: readonly string[]) =>
    ids.filter((id) => outbox.rows.has(id)).map((id) => ({ id, ...outbox.rows.get(id)! })),
  getOutboxFileAudioRecords: async (projectId: string, fileId: string) =>
    [...outbox.rows.entries()]
      .filter(([, r]) => r.event.projectId === projectId && r.event.fileId === fileId)
      .map(([id, r]) => ({ id, ...r })),
  requeueOutboxEvents: async () => {},
  subscribeToOutbox: (cb: () => void) => {
    outbox.subscribers.add(cb)
    return () => outbox.subscribers.delete(cb)
  },
}))

import { useFileAudioAttachments } from "./useFileAudioAttachments"
import {
  __resetShadowRehydrationForTests,
  clearOptimisticShadows,
  injectOptimisticAudioAttachment,
  injectOptimisticAudioRemove,
} from "@/lib/audio/audio-attachments-bus"

const TAKE: AudioAttachmentOut = {
  audioId: "audio-c1-100-take.webm", url: "frontier-audio://take", slot: "recording",
  mimeType: "audio/webm", voiceId: null, referenceAudioId: null,
  durationMs: 2000, trimStartMs: null, trimEndMs: null,
}
const PROGRAMME: AudioAttachmentOut = {
  audioId: "audio-f1-100-programme.mp3", url: "frontier-audio://programme", slot: "recording",
  mimeType: "audio/mpeg", voiceId: null, referenceAudioId: null,
  durationMs: 60_000, trimStartMs: 0, trimEndMs: 2000, role: "source",
}

const entry = (over: Partial<CellAudioEntry> = {}): { cells: Record<string, CellAudioEntry> } => ({
  cells: {
    c1: { attachments: {}, selectedAudioId: null, selectedGeneratedVoiceAudioId: null, audioTimings: {}, ...over },
  },
})

/** Queue a cell.audio.* event in the fake outbox, as its emitter would. */
function queue(id: string, kind: string, payload: Record<string, unknown>) {
  outbox.rows.set(id, {
    status: "pending",
    event: { kind, projectId: "p1", fileId: "f1", cellId: "c1", payload },
  })
}
const attachPayload = (att: AudioAttachmentOut, extra: Record<string, unknown> = {}) => ({
  audioId: att.audioId, url: att.url, slot: att.slot, ...extra,
})

function mount(lane: string) {
  return renderHook(({ lane: l }: { lane: string }) => useFileAudioAttachments("p1", "f1", l), {
    initialProps: { lane },
  })
}
type Mounted = ReturnType<typeof mount>
const idsOn = (r: Mounted["result"]) => Object.keys(r.current.byCellId.get("c1")?.attachments ?? {}).sort()

async function switchLane(view: Mounted, lane: string) {
  view.rerender({ lane })
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith("p1", "f1", "sync-tok", lane))
  await act(async () => {
    await view.result.current.revalidate()
  })
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(entry())
  outbox.rows.clear()
  outbox.subscribers.clear()
  clearOptimisticShadows("f1")
  __resetShadowRehydrationForTests()
})

describe("a take waiting to sync shows in its own lane only (AQU-1978)", () => {
  it("a French take still in the outbox is not painted on the default lane", async () => {
    const view = mount("fr")
    await waitFor(() => expect(view.result.current.hasLoaded).toBe(true))
    queue("evt-fr", "cell.audio.attach", attachPayload(TAKE, { targetLang: "fr" }))
    act(() => injectOptimisticAudioAttachment("f1", "c1", TAKE, "evt-fr"))
    await act(async () => {
      await view.result.current.revalidate()
    })
    expect(idsOn(view.result)).toEqual([TAKE.audioId])

    await switchLane(view, "")
    expect(idsOn(view.result)).toEqual([])

    // Still queued, so French still shows it when the editor comes back.
    await switchLane(view, "fr")
    expect(idsOn(view.result)).toEqual([TAKE.audioId])
  })

  it("an old project's default-lane take (no tag) shows on the default lane only", async () => {
    const view = mount("")
    await waitFor(() => expect(view.result.current.hasLoaded).toBe(true))
    queue("evt-sw", "cell.audio.attach", attachPayload(TAKE))
    act(() => injectOptimisticAudioAttachment("f1", "c1", TAKE, "evt-sw"))
    await act(async () => {
      await view.result.current.revalidate()
    })
    expect(idsOn(view.result)).toEqual([TAKE.audioId])

    await switchLane(view, "fr")
    expect(idsOn(view.result)).toEqual([])
  })

  it("an import's shared programme audio shows in every lane", async () => {
    const view = mount("fr")
    await waitFor(() => expect(view.result.current.hasLoaded).toBe(true))
    queue("evt-src", "cell.audio.attach", attachPayload(PROGRAMME, { role: "source" }))
    act(() => injectOptimisticAudioAttachment("f1", "c1", PROGRAMME, "evt-src"))
    await act(async () => {
      await view.result.current.revalidate()
    })
    expect(idsOn(view.result)).toEqual([PROGRAMME.audioId])

    await switchLane(view, "")
    expect(idsOn(view.result)).toEqual([PROGRAMME.audioId])
  })

  it("a take rebuilt from the outbox after a reload keeps to the lane its event names", async () => {
    // Queued before the "reload": nothing in memory, only the durable outbox.
    queue("evt-queued", "cell.audio.attach", attachPayload(TAKE, { targetLang: "fr" }))
    const view = mount("")
    await waitFor(() => expect(view.result.current.hasLoaded).toBe(true))
    await act(async () => {
      await view.result.current.revalidate()
    })
    expect(idsOn(view.result)).toEqual([])

    await switchLane(view, "fr")
    expect(idsOn(view.result)).toEqual([TAKE.audioId])
  })

  it("another lane's read cannot retire a French delete before French catches up", async () => {
    // The default lane's read never holds the French take, so to it a French
    // delete always looks "done". Retiring the overlay on that evidence let
    // the take flash back in French while French's own read was still stale.
    fetchMock.mockImplementation(async (_p: string, _f: string, _t: string, lane?: string) =>
      lane === "fr" ? entry({ attachments: { [TAKE.audioId]: TAKE }, selectedAudioId: TAKE.audioId }) : entry(),
    )
    const view = mount("fr")
    await waitFor(() => expect(idsOn(view.result)).toEqual([TAKE.audioId]))
    queue("evt-rm", "cell.audio.remove", { audioId: TAKE.audioId, targetLang: "fr" })
    act(() => injectOptimisticAudioRemove("f1", "c1", TAKE.audioId, "recording", "evt-rm"))
    await act(async () => {
      await view.result.current.revalidate()
    })
    expect(idsOn(view.result)).toEqual([])

    // Delivered while the editor is on the default lane.
    outbox.rows.delete("evt-rm")
    await switchLane(view, "")
    await switchLane(view, "fr")
    expect(idsOn(view.result)).toEqual([])
  })
})
