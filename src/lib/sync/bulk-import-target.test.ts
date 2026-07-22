import { describe, it, expect, beforeEach } from "vitest"
import "fake-indexeddb/auto"

import { enqueueTargetCommits, type TargetCommit } from "./bulk-import"
import { peekOutboxBatch, resetOutboxConnectionForTests } from "./outbox"

// Target import now ENQUEUES to the CQRS outbox instead of POSTing directly:
// the background flusher owns the network, so these tests assert on what lands
// in the outbox (shape + idempotent batching), not on fetch calls. Network
// failure / retry / dead-letter is the flusher's responsibility and is covered
// by outbox + outbox-flush tests.

const commits: TargetCommit[] = [
  { id: "ev-t1", cellId: "cell-1", parentId: "ev-s1", value: "target one" },
  { id: "ev-t2", cellId: "cell-2", parentId: "ev-s2", value: "target two" },
]

describe("enqueueTargetCommits", () => {
  beforeEach(async () => {
    await resetOutboxConnectionForTests()
    await new Promise<void>((resolve, reject) => {
      const d = indexedDB.deleteDatabase("aquilla-cqrs-outbox")
      d.onblocked = () => resolve()
      d.onsuccess = () => resolve()
      d.onerror = () => reject(d.error)
    })
  })

  it("enqueues target.cell.commit events to the outbox with correct AD-2 pairing shapes", async () => {
    let fetched = false
    await enqueueTargetCommits({
      projectId: "proj-1",
      fileId: "file-1",
      author: "dev",
      commits,
      getToken: async () => "tok",
      // The flusher owns the network — enqueue must not touch fetch.
      fetchImpl: (async () => { fetched = true; return new Response("{}") }) as unknown as typeof fetch,
    })
    expect(fetched).toBe(false)

    const rows = await peekOutboxBatch(100)
    const mine = rows.filter((r) => ["ev-t1", "ev-t2"].includes(r.id))
    expect(mine).toHaveLength(2)
    const first = mine.find((r) => r.id === "ev-t1")!
    expect(first.event).toMatchObject({
      id: "ev-t1",
      kind: "target.cell.commit",
      projectId: "proj-1",
      fileId: "file-1",
      cellId: "cell-1",
      parentId: "ev-s1", // AD-2 parent = the paired source cell's event id
      payload: { value: "target one", sourceEventId: "ev-s1" },
    })
    // Enqueued as pending so the flusher will drain it and the overlay shows it.
    expect(first.status ?? "pending").toBe("pending")
  })

  it("enqueues a large commit set in one batch (no chunking)", async () => {
    const many: TargetCommit[] = Array.from({ length: 450 }, (_, i) => ({
      id: `t${i}`, cellId: `c${i}`, parentId: `s${i}`, value: `v${i}`,
    }))
    await enqueueTargetCommits({
      projectId: "p", fileId: "f", author: "dev", commits: many,
      getToken: async () => "tok",
    })
    const rows = await peekOutboxBatch(1000)
    expect(rows.filter((r) => r.id.startsWith("t"))).toHaveLength(450)
  })

  it("addresses an explicit target lane without changing default-lane payloads", async () => {
    await enqueueTargetCommits({
      projectId: "p",
      fileId: "f",
      author: "dev",
      targetLang: "fr-CA",
      commits: [commits[0]],
      getToken: async () => "tok",
    })
    const explicit = (await peekOutboxBatch(100)).find((row) => row.id === "ev-t1")!
    expect(explicit.event.payload).toMatchObject({
      value: "target one",
      sourceEventId: "ev-s1",
      targetLang: "fr-CA",
    })

    await resetOutboxConnectionForTests()
    await new Promise<void>((resolve, reject) => {
      const d = indexedDB.deleteDatabase("aquilla-cqrs-outbox")
      d.onblocked = () => resolve()
      d.onsuccess = () => resolve()
      d.onerror = () => reject(d.error)
    })
    await enqueueTargetCommits({
      projectId: "p",
      fileId: "f",
      author: "dev",
      targetLang: "",
      commits: [commits[0]],
      getToken: async () => "tok",
    })
    const defaultLane = (await peekOutboxBatch(100)).find((row) => row.id === "ev-t1")!
    expect(defaultLane.event.payload).not.toHaveProperty("targetLang")
  })

  it("is a no-op with zero commits (no outbox writes)", async () => {
    await enqueueTargetCommits({
      projectId: "p", fileId: "f", author: "dev", commits: [],
      getToken: async () => { throw new Error("should not mint a token") },
    })
    const rows = await peekOutboxBatch(100)
    expect(rows).toHaveLength(0)
  })

  it("reports progress once with the total count", async () => {
    const progress: Array<[number, number]> = []
    await enqueueTargetCommits({
      projectId: "p", fileId: "f", author: "dev", commits,
      getToken: async () => "tok",
      onProgress: (uploaded, total) => progress.push([uploaded, total]),
    })
    expect(progress).toEqual([[2, 2]])
  })
})
