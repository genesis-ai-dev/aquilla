// AQU-1495: deleting a track removed its recordings with no overlay, so they —
// and the editor's audio column with them — stayed on screen until the socket
// echoed each remove back, and across a socket gap until a reload. The batch
// now gives every take the overlay a single remove gets.
import { describe, expect, it, vi } from "vitest"

const enqueued = vi.hoisted(() => ({ inputs: [] as Array<Record<string, unknown>> }))
vi.mock("@/lib/sync/events-emit", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enqueueEvents: vi.fn(async (inputs: Array<Record<string, unknown>>) => {
    enqueued.inputs = inputs
    return inputs.map((_, i) => ({ event: {}, eventId: `ev-${i}` }))
  }),
}))

const recorded = vi.hoisted(() => ({ steps: [] as Array<Record<string, unknown>> }))
vi.mock("@/lib/history/history", () => ({
  recordStep: vi.fn((step: Record<string, unknown>) => { recorded.steps.push(step) }),
}))

import { enqueueTakeRemovals, hasOwnRecordingLeft, removeTake, removeWholeTake } from "./take-actions"
import { pieceStretchOf } from "@/lib/history/take-steps"
import { getOptimisticShadows, subscribeOptimisticAudioAttachment } from "./audio-attachments-bus"

describe("enqueueTakeRemovals", () => {
  it("queues one remove per take, each against the file its cell lives in", async () => {
    await enqueueTakeRemovals([
      { projectId: "p", fileId: "subs", cellId: "c1", audioId: "a1", slot: "track-9" },
      { projectId: "p", fileId: "cues", cellId: "q1", audioId: "a2", slot: "track-9" },
    ], "tester")
    expect(enqueued.inputs).toEqual([
      expect.objectContaining({ kind: "cell.audio.remove", projectId: "p", fileId: "subs", cellId: "c1", author: "tester", payload: { audioId: "a1" } }),
      expect.objectContaining({ kind: "cell.audio.remove", projectId: "p", fileId: "cues", cellId: "q1", author: "tester", payload: { audioId: "a2" } }),
    ])
  })

  it("takes every take off the screen at once, bound to its own queued event", async () => {
    const seen: Array<[string, string, unknown]> = []
    const offA = subscribeOptimisticAudioAttachment("file-a", (cellId, shadow) => seen.push(["file-a", cellId, shadow]))
    const offB = subscribeOptimisticAudioAttachment("file-b", (cellId, shadow) => seen.push(["file-b", cellId, shadow]))
    const touched = await enqueueTakeRemovals([
      { projectId: "p", fileId: "file-a", cellId: "c1", audioId: "x1", slot: "track-2" },
      { projectId: "p", fileId: "file-a", cellId: "c2", audioId: "x2", slot: "track-2" },
      { projectId: "p", fileId: "file-b", cellId: "c3", audioId: "x3", slot: "track-2" },
    ], "tester")
    offA()
    offB()

    expect(seen.map(([file, cell, shadow]) => [file, cell, (shadow as { kind: string; audioId: string; slot: string }).kind,
      (shadow as { audioId: string }).audioId, (shadow as { slot: string }).slot])).toEqual([
      ["file-a", "c1", "remove", "x1", "track-2"],
      ["file-a", "c2", "remove", "x2", "track-2"],
      ["file-b", "c3", "remove", "x3", "track-2"],
    ])
    // Bound to its event, so it lasts exactly as long as the remove is queued.
    expect(getOptimisticShadows("file-a").get("c2")?.[0]?.eventId).toBe("ev-1")
    // Each file is poked once, after the batch is sent.
    expect(touched).toEqual(["file-a", "file-b"])
  })
})

// AQU-1767 (Sam, 2026-10-14): the delete on a split take's top row removes the
// whole take, as one step.
describe("removeWholeTake", () => {
  it("removes every piece in one go and records one step naming them all", async () => {
    recorded.steps = []
    await removeWholeTake({
      projectId: "p", fileId: "f", cellId: "c1", author: "tester", history: { wasSelected: true },
      pieces: [{ audioId: "t1", slot: "recording" }, { audioId: "p2", slot: "recording" }],
    })
    expect(enqueued.inputs.map((e) => (e.payload as { audioId: string }).audioId)).toEqual(["t1", "p2"])
    expect(recorded.steps).toHaveLength(1)
    expect(recorded.steps[0]).toMatchObject({
      kind: "take.remove",
      data: { cellId: "c1", audioId: "t1", slot: "recording", wasSelected: true, pieces: ["p2"] },
    })
  })

  // AQU-2492 (review, Nov 9), finding 8: the step notes who had approved
  // each piece, which its Undo gives back with them, so only an approval
  // given after the Undo stops the Redo.
  it("notes who had approved each piece when it was deleted", async () => {
    recorded.steps = []
    await removeWholeTake({
      projectId: "p", fileId: "f", cellId: "c1", author: "tester", history: { wasSelected: true },
      pieces: [{ audioId: "t1", slot: "recording", validators: ["ben"] }, { audioId: "p2", slot: "recording" }],
    })
    expect(recorded.steps[0]).toMatchObject({ data: { approvedBy: { t1: ["ben"], p2: [] } } })
  })

  it("…and for a take in one piece", async () => {
    recorded.steps = []
    await removeTake({
      projectId: "p", fileId: "f", cellId: "c1", audioId: "t1", slot: "recording", author: "tester",
      history: { wasSelected: true, approvedBy: ["ben", "cal"] },
    })
    expect(recorded.steps[0]).toMatchObject({ kind: "take.remove", data: { audioId: "t1", approvedBy: { t1: ["ben", "cal"] } } })
  })

  // AQU-2492 (review, Nov 12): a deleted piece is never sent to the browser
  // again, so its step keeps where it sat in its take: its Undo must not bring
  // it back over a stretch another piece of the take plays by then.
  it("notes where a deleted piece sat in its take", async () => {
    recorded.steps = []
    await removeTake({
      projectId: "p", fileId: "f", cellId: "c1", audioId: "p2", slot: "recording", author: "tester",
      history: { wasSelected: true, approvedBy: [], stretch: pieceStretchOf("p2", { pieceOf: "t1", trimStartMs: 1700, trimEndMs: null, durationMs: 3400 }) },
    })
    expect(recorded.steps[0]).toMatchObject({ data: { audioId: "p2", stretches: { p2: { pieceOf: "t1", startMs: 1700, endMs: 3400 } } } })
  })
})

// AQU-2411: given the line, "is any recording left?" follows the one own-take
// rule, so a take migrated from Codex under an untagged id still counts.
describe("hasOwnRecordingLeft", () => {
  const CODEX = "audio-1719100000000-k3j9x2m1p.webm"
  const NEW = "audio-c1-1762300000000-abc123def"
  const SOURCE = "audio-f1-1762300000000-zzz999yyy"
  const verse = { id: "c1", fileId: "f1" }

  it("finds a Codex take left on a verse after removing a newer one", () => {
    const takes = [{ audioId: NEW }, { audioId: CODEX }]
    expect(hasOwnRecordingLeft(takes, NEW, verse)).toBe(true)
  })

  it("does not count the file's own recording, a generated voice, or a section's untagged recording", () => {
    expect(hasOwnRecordingLeft([{ audioId: NEW }, { audioId: SOURCE }], NEW, verse)).toBe(false)
    expect(hasOwnRecordingLeft([{ audioId: NEW }, { audioId: CODEX, voiceId: "v1" }], NEW, verse)).toBe(false)
    expect(hasOwnRecordingLeft([{ audioId: NEW }, { audioId: CODEX }], NEW, { ...verse, medium: "media" })).toBe(false)
  })

  it("keeps the strict test when only the line's id is known", () => {
    expect(hasOwnRecordingLeft([{ audioId: NEW }, { audioId: CODEX }], NEW, "c1")).toBe(false)
  })
})
