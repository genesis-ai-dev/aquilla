// Comments read client: cursor paging + the counts aggregate.
//
// Why: the worker now returns 200 rows per page. A client that stopped at the
// first page would silently hide older threads; a client that ignored the
// counts endpoint would put the badge back on the full list.
import { describe, it, expect, vi, afterEach } from "vitest"
import { fetchCommentCounts, fetchCommentsForProject, fetchCommentsPage } from "./comments-read"
import type { CommentRecord } from "./comments-read-types"

function row(i: number): CommentRecord {
  return {
    commentId: `c${i}`, projectId: "p1", scopeKind: "project", fileId: null, cellId: null,
    parentCommentId: null, body: `b${i}`, resolved: false, authorId: "a", authorLabel: "a",
    createdAt: i, updatedAt: i, deletedAt: null,
  }
}

function json(body: object): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
}

afterEach(() => vi.unstubAllGlobals())

describe("fetchCommentsForProject — follows nextCursor to the end", () => {
  it("requests each page with the previous cursor, reports progress, and concatenates", async () => {
    const calls: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url)
      const cursor = new URL(url).searchParams.get("cursor")
      if (!cursor) return json({ comments: [row(1), row(2)], nextCursor: "cur-2" })
      if (cursor === "cur-2") return json({ comments: [row(3)], nextCursor: "cur-3" })
      return json({ comments: [], nextCursor: null })
    }))
    const progress: number[] = []
    const all = await fetchCommentsForProject("p1", "jwt", { fileId: "f1" }, (soFar) => progress.push(soFar.length))

    expect(all.map((c) => c.commentId)).toEqual(["c1", "c2", "c3"])
    expect(progress).toEqual([2, 3, 3])
    expect(calls).toHaveLength(3)
    expect(calls[0]).toContain("fileId=f1")
    expect(calls[0]).not.toContain("cursor=")
    expect(calls[1]).toContain("cursor=cur-2")
    expect(calls[2]).toContain("cursor=cur-3")
  })

  it("treats a pre-paging worker (no nextCursor field) as a single page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ comments: [row(1)] })))
    expect(await fetchCommentsForProject("p1", "jwt")).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("fetchCommentsPage forwards limit and scope and surfaces the cursor", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ comments: [row(1)], nextCursor: "n" })))
    const page = await fetchCommentsPage("p1", "jwt", { fileId: "f", cellId: "c", limit: 50 })
    const url = (fetch as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]
    expect(url).toContain("fileId=f")
    expect(url).toContain("cellId=c")
    expect(url).toContain("limit=50")
    expect(page.nextCursor).toBe("n")
  })
})

describe("fetchCommentCounts", () => {
  it("hits /comments/counts with the bearer token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ unresolved: 3, byFile: { f1: 2, "": 1 } })))
    const counts = await fetchCommentCounts("p 1", "jwt")
    const [url, init] = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(url).toMatch(/\/projects\/p%201\/comments\/counts$/)
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt")
    expect(counts).toEqual({ unresolved: 3, byFile: { f1: 2, "": 1 } })
  })
})

// AQU-1275 — a VPN that hangs or drops one comment page used to wedge the whole
// project refresh (no timeout) and leave the client holding a partial list that
// the drawer rendered as "No comments yet". The read path now carries the same
// timeout + bounded-retry contract as cells-read.ts.
describe("AQU-1275 — transport resilience", () => {
  it("arms a request timeout on every comments read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ comments: [], nextCursor: null })))
    await fetchCommentsPage("p1", "jwt")
    const [, init] = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    // happy-dom provides AbortSignal.timeout; engines without it degrade to
    // `undefined` (see fetch-timeout.ts) rather than losing the request.
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it("retries a transport failure and succeeds on a later attempt", async () => {
    let attempts = 0
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempts++
      if (attempts === 1) throw new TypeError("Failed to fetch")
      return json({ comments: [row(1)], nextCursor: null })
    }))
    const page = await fetchCommentsPage("p1", "jwt")
    expect(attempts).toBe(2)
    expect(page.comments.map((c) => c.commentId)).toEqual(["c1"])
  })

  it("retries a timeout abort — the hung-page case from the report", async () => {
    let attempts = 0
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempts++
      if (attempts < 3) {
        const err = new Error("timed out")
        err.name = "TimeoutError"
        throw err
      }
      return json({ comments: [row(2)], nextCursor: null })
    }))
    const page = await fetchCommentsPage("p1", "jwt")
    expect(attempts).toBe(3)
    expect(page.comments.map((c) => c.commentId)).toEqual(["c2"])
  })

  it("does NOT retry a deterministic 4xx — an auth failure must surface at once", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("forbidden", { status: 403 })))
    await expect(fetchCommentsPage("p1", "jwt")).rejects.toThrow(/HTTP 403/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("gives up after the bounded budget instead of retrying forever", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 503 })))
    await expect(fetchCommentCounts("p1", "jwt")).rejects.toThrow(/HTTP 503/)
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})
