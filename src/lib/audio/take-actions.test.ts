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

import { enqueueTakeRemovals } from "./take-actions"
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
