import { describe, it, expect, vi } from "vitest"

vi.mock("./sync-worker-url", () => ({
  syncWorkerHttpOrigin: () => "https://sync.example.test",
}))

import { bulkUploadTargetCommits, type TargetCommit } from "./bulk-import"

function fakeFetchOk(record: { url: string; body: Record<string, unknown> }[]): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    record.push({ url: String(url), body: JSON.parse(String(init.body)) })
    return { ok: true, status: 200, text: async () => "" } as Response
  }) as unknown as typeof fetch
}

const commits: TargetCommit[] = [
  { id: "ev-t1", cellId: "cell-1", parentId: "ev-s1", value: "target one" },
  { id: "ev-t2", cellId: "cell-2", parentId: "ev-s2", value: "target two" },
]

describe("bulkUploadTargetCommits", () => {
  it("posts target.cell.commit events to /events with correct pairing shapes", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = []
    await bulkUploadTargetCommits({
      projectId: "proj-1",
      fileId: "file-1",
      author: "dev",
      commits,
      getToken: async () => "tok",
      fetchImpl: fakeFetchOk(calls),
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("https://sync.example.test/events")
    const events = (calls[0].body as { events: Record<string, unknown>[] }).events
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      id: "ev-t1",
      kind: "target.cell.commit",
      projectId: "proj-1",
      fileId: "file-1",
      cellId: "cell-1",
      parentId: "ev-s1", // AD-2 parent = the paired source cell's event id
      payload: { value: "target one", sourceEventId: "ev-s1" },
    })
  })

  it("chunks large commit sets (200/chunk)", async () => {
    const many: TargetCommit[] = Array.from({ length: 450 }, (_, i) => ({
      id: `t${i}`, cellId: `c${i}`, parentId: `s${i}`, value: `v${i}`,
    }))
    const calls: { url: string; body: Record<string, unknown> }[] = []
    await bulkUploadTargetCommits({
      projectId: "p", fileId: "f", author: "dev", commits: many,
      getToken: async () => "tok", fetchImpl: fakeFetchOk(calls),
    })
    expect(calls).toHaveLength(3) // 200 + 200 + 50
    const totalEvents = calls.reduce(
      (n, c) => n + (c.body as { events: unknown[] }).events.length, 0,
    )
    expect(totalEvents).toBe(450)
  })

  it("is a no-op with zero commits (no token mint, no fetch)", async () => {
    let fetched = false
    await bulkUploadTargetCommits({
      projectId: "p", fileId: "f", author: "dev", commits: [],
      getToken: async () => { throw new Error("should not mint a token") },
      fetchImpl: (async () => { fetched = true; return { ok: true } as Response }) as unknown as typeof fetch,
    })
    expect(fetched).toBe(false)
  })

  it("throws a clear error on HTTP failure", async () => {
    const failFetch = (async () => ({
      ok: false, status: 409, text: async () => "stale",
    })) as unknown as typeof fetch
    await expect(
      bulkUploadTargetCommits({
        projectId: "p", fileId: "f", author: "dev", commits,
        getToken: async () => "tok", fetchImpl: failFetch,
      }),
    ).rejects.toThrow(/Target commit failed \(HTTP 409\)/)
  })
})
