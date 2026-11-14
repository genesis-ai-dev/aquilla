// AQU-2495 (review, round 3): two trims made on the Recording tab, with a move,
// a volume change or a cut made on the timeline between them, all still
// saving. The second trim must show, right away and after the next read, and
// never snap back to the first (which would play that window and drop the
// second trim's Undo as "changed since"). A trim-only copy beside the other
// writes' whole-take copies did snap back (fb17e9b50, reverted); the trim's
// copy of the whole take, as the timeline's trims paint on dev, takes every
// later write into one copy and does not. Through the real overlay and read,
// with each surface's own paint: the Recording tab's trim is `persistTakeTrim`,
// the timeline's writes are the workspace's applyTakePlace / applyTakeGain /
// applyTakeCut. (On dev a volume change or a cut's name and approvals made
// while a trim saves are folded into the trim's copy and not painted until it
// yields; that is dev's behaviour for every trim, and not asserted here.)
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
const trims = vi.hoisted(() => ({ n: 0 }))
vi.mock("@/lib/sync/events-emit", () => ({ emitCellAudioTrim: vi.fn(async () => `evt-trim-${++trims.n}`) }))

import { useFileAudioAttachments } from "./useFileAudioAttachments"
import {
  clearOptimisticShadows,
  injectOptimisticAudioAttachment,
  injectOptimisticAudioPlace,
  injectOptimisticAudioTrim,
} from "@/lib/audio/audio-attachments-bus"
import { persistTakeTrim } from "@/lib/audio/persist-trim"
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
/** The take as the page reads it right now (what each write starts from). */
const now = (r: Hook) => ({ type: "audio", ...r.current.byCellId.get("c1")!.attachments[T] }) as unknown as CodexCellAttachment
const shown = (r: Hook) => r.current.byCellId.get("c1")?.attachments[T]
const settle = async (r: Hook) => act(async () => { await r.current.revalidate() })

/** A trim on the Recording tab (CellTakeBlock's commitTrim). */
const tabTrim = (r: Hook, startMs: number) => act(async () => {
  await persistTakeTrim({ projectId: "p1", fileId: "f1", cellId: "c1", audioId: T, att: now(r), trimStartMs: startMs, trimEndMs: now(r).trimEndMs ?? null, author: "dev" })
})
// The timeline's writes, painted as the workspace paints them.
const move = (r: Hook) => act(() => injectOptimisticAudioPlace("f1", "c1", { ...attachmentOutFrom(T, now(r), "recording"), targetOffsetMs: 900, recordingsOffsetMs: null }, "evt-place"))
const volume = (r: Hook) => act(() => injectOptimisticAudioTrim("f1", "c1", { ...attachmentOutFrom(T, now(r), "recording"), gainDb: -9, fadeInMs: null, fadeOutMs: null }, "evt-gain"))
const cut = (r: Hook) => act(() => {
  const shared = attachmentOutFrom(T, now(r), "recording")
  injectOptimisticAudioTrim("f1", "c1", { ...shared, trimEndMs: 2000, validatorCount: 0, validators: [], label: "Take 1 · 1" }, "evt-cut")
  injectOptimisticAudioAttachment("f1", "c1", { ...shared, audioId: P2, trimStartMs: 2000, validatorCount: 0, validators: [], pieceOf: T, label: "Take 1 · 2" }, "evt-cut", { claimSelection: false })
})

beforeEach(() => {
  fetchMock.mockReset()
  clearOptimisticShadows("f1")
  trims.n = 0
})

async function ready() {
  fetchMock.mockResolvedValue(read([TAKE]))
  const { result } = mount()
  await waitFor(() => expect(shown(result)).toBeDefined())
  return result
}

describe("two Recording-tab trims with a timeline write between them, all saving (AQU-2495, round 3)", () => {
  for (const [what, write, also] of [
    ["a move", move, { targetOffsetMs: 900 }],
    ["a volume change", volume, {}],
    ["a cut", cut, { trimEndMs: 2000 }],
  ] as const) {
    it(`trim, ${what}, trim again: the second trim shows, and stays after the next read`, async () => {
      const r = await ready()
      await tabTrim(r, 500)
      await write(r)
      await tabTrim(r, 800)
      expect(shown(r), "right after the second trim").toMatchObject({ trimStartMs: 800, ...also })
      await settle(r)
      expect(shown(r), "after the next read").toMatchObject({ trimStartMs: 800, ...also })
    })
  }
})
