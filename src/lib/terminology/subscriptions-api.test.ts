import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  publishTermbase,
  unpublishTermbase,
  listPublishedTermbases,
  listSubscriptions,
  subscribeTermbase,
  unsubscribeTermbase,
  reorderSubscriptions,
  TermbaseApiError,
} from "./subscriptions-api"

const ORIG = global.fetch
beforeEach(() => {
  global.fetch = vi.fn()
})
afterEach(() => {
  global.fetch = ORIG
})

function ok(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

describe("publishTermbase", () => {
  it("POSTs to the publish endpoint and returns published:true", async () => {
    ;(global.fetch as any).mockResolvedValueOnce(ok({ projectId: "p1", published: true }))
    const res = await publishTermbase("jwt", "p1")
    expect(res).toEqual({ projectId: "p1", published: true })
    const [url, init] = (global.fetch as any).mock.calls[0]
    expect(url).toMatch(/\/api\/v2\/projects\/p1\/termbase\/publish$/)
    expect(init.method).toBe("POST")
    expect((init.headers as any).Authorization).toBe("Bearer jwt")
  })

  // AQU-820: TermbaseSharingSection renders `e.message` verbatim, so the raw
  // (untranslated) server string must stay off `.message` and live on `.cause`.
  it("throws TermbaseApiError with our keyed message, server text only on .cause", async () => {
    ;(global.fetch as any).mockResolvedValueOnce(
      ok({ error: "project is not org-owned; cannot publish to an org" }, 409),
    )
    const err = await publishTermbase("jwt", "p1").catch((e: unknown) => e)
    expect(err).toMatchObject({
      name: "TermbaseApiError",
      status: 409,
      message: "Couldn't share this termbase with the organization.",
    })
    expect(String((err as Error).cause)).toContain("not org-owned")
  })
})

describe("unpublishTermbase", () => {
  it("DELETEs and returns published:false", async () => {
    ;(global.fetch as any).mockResolvedValueOnce(ok({ projectId: "p1", published: false }))
    const res = await unpublishTermbase("jwt", "p1")
    expect(res.published).toBe(false)
    expect((global.fetch as any).mock.calls[0][1].method).toBe("DELETE")
  })
})

describe("listPublishedTermbases", () => {
  it("unwraps { termbases }", async () => {
    ;(global.fetch as any).mockResolvedValueOnce(
      ok({ termbases: [{ projectId: "t1", name: "Greek NT", createdBy: "anna" }] }),
    )
    const res = await listPublishedTermbases("jwt", 5)
    expect(res).toHaveLength(1)
    expect(res[0].name).toBe("Greek NT")
    expect((global.fetch as any).mock.calls[0][0]).toMatch(
      /\/api\/v2\/orgs\/5\/published-termbases$/,
    )
  })

  it("returns [] when termbases is absent", async () => {
    ;(global.fetch as any).mockResolvedValueOnce(ok({}))
    expect(await listPublishedTermbases("jwt", 5)).toEqual([])
  })
})

describe("listSubscriptions", () => {
  it("unwraps { subscriptions }", async () => {
    ;(global.fetch as any).mockResolvedValueOnce(
      ok({
        subscriptions: [
          {
            termbaseProjectId: "t1",
            termbaseName: "A",
            priority: 0,
            createdAt: "2026-01-01",
            published: true,
          },
        ],
      }),
    )
    const res = await listSubscriptions("jwt", "p1")
    expect(res[0].termbaseProjectId).toBe("t1")
  })
})

describe("subscribeTermbase", () => {
  it("POSTs termbaseProjectId without priority when omitted", async () => {
    ;(global.fetch as any).mockResolvedValueOnce(
      ok({ subscription: { termbaseProjectId: "t1", priority: 3, createdAt: "x" } }),
    )
    const res = await subscribeTermbase("jwt", "p1", "t1")
    expect(res.priority).toBe(3)
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body)
    expect(body).toEqual({ termbaseProjectId: "t1" })
  })

  it("includes priority when provided", async () => {
    ;(global.fetch as any).mockResolvedValueOnce(
      ok({ subscription: { termbaseProjectId: "t1", priority: 0, createdAt: "x" } }),
    )
    await subscribeTermbase("jwt", "p1", "t1", 0)
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body)
    expect(body).toEqual({ termbaseProjectId: "t1", priority: 0 })
  })

  it("surfaces the 409 cross-org error", async () => {
    ;(global.fetch as any).mockResolvedValueOnce(
      ok({ error: "termbase is not published to this org" }, 409),
    )
    await expect(subscribeTermbase("jwt", "p1", "t1")).rejects.toBeInstanceOf(
      TermbaseApiError,
    )
  })
})

describe("unsubscribeTermbase", () => {
  it("DELETEs the nested termbase path", async () => {
    ;(global.fetch as any).mockResolvedValueOnce(ok({ ok: true }))
    const res = await unsubscribeTermbase("jwt", "p1", "t1")
    expect(res.ok).toBe(true)
    expect((global.fetch as any).mock.calls[0][0]).toMatch(
      /\/projects\/p1\/termbase\/subscriptions\/t1$/,
    )
    expect((global.fetch as any).mock.calls[0][1].method).toBe("DELETE")
  })
})

describe("reorderSubscriptions", () => {
  it("PATCHes { order } and returns the new subscription list", async () => {
    ;(global.fetch as any).mockResolvedValueOnce(
      ok({
        subscriptions: [
          { termbaseProjectId: "t2", termbaseName: "B", priority: 0, createdAt: "x", published: true },
          { termbaseProjectId: "t1", termbaseName: "A", priority: 1, createdAt: "x", published: true },
        ],
      }),
    )
    const res = await reorderSubscriptions("jwt", "p1", ["t2", "t1"])
    expect(res.map((s) => s.termbaseProjectId)).toEqual(["t2", "t1"])
    const init = (global.fetch as any).mock.calls[0][1]
    expect(init.method).toBe("PATCH")
    expect(JSON.parse(init.body)).toEqual({ order: ["t2", "t1"] })
  })
})
