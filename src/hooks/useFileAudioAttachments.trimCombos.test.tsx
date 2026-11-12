// AQU-2495 (review, round 2): every trim — the timeline's handles, the
// Station (both through the workspace's `applyTakeTrim`) and the Recording tab
// — paints one kind of copy while it saves (`paintTakeTrim`): its window
// alone, over the take as read. These run each other write the workspace
// paints on a take — a move, a volume change, a cut, an Undo of a cut — while
// a trim of it is still saving, in both orders, through the real overlay and
// the real read, with the workspace's own paint for each write. Every write
// still on its way is shown; a colleague's change in the read shows too.
import { readFileSync } from "node:fs"
import { join } from "node:path"
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
// Every write here is still saving: its event sits in the outbox.
vi.mock("@/lib/sync/outbox", () => ({
  getOutboxRecords: async (ids: readonly string[]) => ids.map((id) => ({ id, status: "pending" })),
  subscribeToOutbox: () => () => {},
}))

import { useFileAudioAttachments } from "./useFileAudioAttachments"
import {
  clearOptimisticShadows,
  injectOptimisticAudioAttachment,
  injectOptimisticAudioPlace,
  injectOptimisticAudioRemove,
  injectOptimisticAudioTrim,
} from "@/lib/audio/audio-attachments-bus"
import { paintTakeTrim } from "@/lib/audio/persist-trim"
import { attachmentOutFrom } from "@/lib/audio/cut-take"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"

const T = "audio-c1-1700000000-take.wav"
const P2 = "audio-c1-1700000001-piece.wav"
const TAKE: AudioAttachmentOut = {
  audioId: T, url: "frontier-audio://take", slot: "recording", mimeType: "audio/wav", voiceId: null,
  referenceAudioId: null, durationMs: 4000, label: "Take 1", trimStartMs: null, trimEndMs: null,
  targetOffsetMs: 300, recordingsOffsetMs: null, gainDb: -3, validatorCount: 1, validators: ["rita"],
}
const read = (atts: AudioAttachmentOut[]): { cells: Record<string, CellAudioEntry> } => ({
  cells: { c1: { attachments: Object.fromEntries(atts.map((a) => [a.audioId, a])), selectedBySlot: { recording: T }, selectedAudioId: T, selectedGeneratedVoiceAudioId: null, audioTimings: {} } },
})

function mount() {
  return renderHook(() => useFileAudioAttachments("p1", "f1"))
}
type Hook = ReturnType<typeof mount>["result"]
/** The take as the workspace reads it right now (what its writes start from). */
const now = (r: Hook, id = T) => ({ type: "audio", ...r.current.byCellId.get("c1")!.attachments[id] }) as unknown as CodexCellAttachment
const shown = (r: Hook, id = T) => r.current.byCellId.get("c1")?.attachments[id]
const settle = async (r: Hook) => act(async () => { await r.current.revalidate() })

// The workspace's own paint for each write (ProjectWorkspace: applyTakeTrim,
// applyTakePlace, applyTakeGain, applyTakeCut, applyTakeUncut).
const trim = (r: Hook, startMs: number, id = T) => act(() => paintTakeTrim("f1", "c1", id, now(r, id), "recording", { trimStartMs: startMs, trimEndMs: now(r, id).trimEndMs ?? null }, `evt-trim-${startMs}`))
const move = (r: Hook, targetOffsetMs: number) => act(() => injectOptimisticAudioPlace("f1", "c1", { ...attachmentOutFrom(T, now(r), "recording"), targetOffsetMs, recordingsOffsetMs: null }, "evt-place"))
const volume = (r: Hook, gainDb: number) => act(() => injectOptimisticAudioTrim("f1", "c1", { ...attachmentOutFrom(T, now(r), "recording"), gainDb, fadeInMs: null, fadeOutMs: null }, "evt-gain"))
const cutAt = (r: Hook, atMs: number) => act(() => {
  const shared = attachmentOutFrom(T, now(r), "recording")
  injectOptimisticAudioTrim("f1", "c1", { ...shared, trimEndMs: atMs, validatorCount: 0, validators: [], label: "Take 1 · 1" }, "evt-cut")
  injectOptimisticAudioAttachment("f1", "c1", { ...shared, audioId: P2, trimStartMs: atMs, validatorCount: 0, validators: [], pieceOf: T, label: "Take 1 · 2" }, "evt-cut", { claimSelection: false })
})
const uncut = (r: Hook) => act(() => {
  injectOptimisticAudioRemove("f1", "c1", P2, "recording", "evt-uncut")
  injectOptimisticAudioTrim("f1", "c1", { ...attachmentOutFrom(T, now(r), "recording"), trimStartMs: now(r).trimStartMs ?? null, trimEndMs: null, label: "Take 1" }, "evt-uncut")
})

beforeEach(() => {
  fetchMock.mockReset()
  clearOptimisticShadows("f1")
})

async function ready(atts: AudioAttachmentOut[]) {
  fetchMock.mockResolvedValue(read(atts))
  const { result } = mount()
  await waitFor(() => expect(shown(result)).toBeDefined())
  return result
}

describe("a trim still saving, and the take's other writes (AQU-2495, round 2)", () => {
  it("trim, then a move: both show", async () => {
    const r = await ready([TAKE])
    await trim(r, 500)
    await move(r, 900)
    await settle(r)
    expect(shown(r)).toMatchObject({ trimStartMs: 500, targetOffsetMs: 900, label: "Take 1", gainDb: -3 })
  })

  it("a move, then a trim: both show", async () => {
    const r = await ready([TAKE])
    await move(r, 900)
    await trim(r, 500)
    await settle(r)
    expect(shown(r)).toMatchObject({ trimStartMs: 500, targetOffsetMs: 900 })
  })

  it("trim, then a volume change: both show", async () => {
    const r = await ready([TAKE])
    await trim(r, 500)
    await volume(r, -9)
    await settle(r)
    expect(shown(r)).toMatchObject({ trimStartMs: 500, gainDb: -9, targetOffsetMs: 300 })
  })

  it("a volume change, then a trim: both show", async () => {
    const r = await ready([TAKE])
    await volume(r, -9)
    await trim(r, 500)
    await settle(r)
    expect(shown(r)).toMatchObject({ trimStartMs: 500, gainDb: -9 })
  })

  it("trim, then a cut: the trimmed first piece ends at the cut, unapproved, and the second piece is there", async () => {
    const r = await ready([TAKE])
    await trim(r, 500)
    await cutAt(r, 2000)
    await settle(r)
    expect(shown(r)).toMatchObject({ trimStartMs: 500, trimEndMs: 2000, validators: [], label: "Take 1 · 1" })
    expect(shown(r, P2)).toMatchObject({ trimStartMs: 2000, pieceOf: T })
  })

  it("a cut, then a trim of its first piece: the cut stays as it was made, with the new start", async () => {
    const r = await ready([TAKE])
    await cutAt(r, 2000)
    await trim(r, 500)
    await settle(r)
    expect(shown(r)).toMatchObject({ trimStartMs: 500, trimEndMs: 2000, validators: [], label: "Take 1 · 1" })
    expect(shown(r, P2)).toMatchObject({ trimStartMs: 2000 })
  })

  it("a cut take: trim of its first piece, then the Undo of the cut: whole again, with the new start", async () => {
    const r = await ready([{ ...TAKE, trimEndMs: 2000, label: "Take 1 · 1" }, { ...TAKE, audioId: P2, trimStartMs: 2000, pieceOf: T, label: "Take 1 · 2" }])
    await trim(r, 500)
    await uncut(r)
    await settle(r)
    expect(shown(r)).toMatchObject({ trimStartMs: 500, trimEndMs: null, label: "Take 1" })
    expect(shown(r, P2)).toBeUndefined()
  })

  it("a cut take: the Undo of the cut, then a trim: whole again, with the new start", async () => {
    const r = await ready([{ ...TAKE, trimEndMs: 2000, label: "Take 1 · 1" }, { ...TAKE, audioId: P2, trimStartMs: 2000, pieceOf: T, label: "Take 1 · 2" }])
    await uncut(r)
    await trim(r, 500)
    await settle(r)
    expect(shown(r)).toMatchObject({ trimStartMs: 500, trimEndMs: null, label: "Take 1" })
    expect(shown(r, P2)).toBeUndefined()
  })

  it("a colleague's rename and move made while a timeline trim saves show at once", async () => {
    const r = await ready([TAKE])
    await trim(r, 500)
    fetchMock.mockResolvedValue(read([{ ...TAKE, label: "Greeting", targetOffsetMs: 700 }]))
    await settle(r)
    expect(shown(r)).toMatchObject({ trimStartMs: 500, label: "Greeting", targetOffsetMs: 700 })
  })

  it("a length measured while a trim saves shows at once", async () => {
    const r = await ready([{ ...TAKE, durationMs: null }])
    await trim(r, 500)
    act(() => injectOptimisticAudioAttachment("f1", "c1", { ...attachmentOutFrom(T, now(r), "recording"), durationMs: 4321 }, "evt-measure", { claimSelection: false }))
    await settle(r)
    expect(shown(r)).toMatchObject({ trimStartMs: 500, durationMs: 4321 })
  })
})

describe("every trim paints the same copy (AQU-2495, round 2)", () => {
  const source = readFileSync(join(__dirname, "..", "components", "ProjectWorkspace.tsx"), "utf8")
  it("the timeline's handles and the Station trim through applyTakeTrim, which paints with paintTakeTrim", () => {
    const at = source.indexOf("const applyTakeTrim = useCallback(")
    const body = source.slice(at, source.indexOf("\n  )\n", at))
    expect(body).toContain("paintTakeTrim(takeFileId, cellId, audioId, att, slot,")
    expect(body).not.toContain("injectOptimisticAudioTrim(")
    // The Station's trim is the timeline's (its host's `trim`).
    expect(source).toContain("trim: handleTrimTarget,")
    const handler = source.slice(source.indexOf("const handleTrimTarget = useCallback("))
    expect(handler.slice(0, handler.indexOf("\n  )\n"))).toContain("await applyTakeTrim(cellId, audioId, trims)")
  })
})
