// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest"
import { retryingFetch, HttpError, SyncClient, GitLabClient, INBOX_PAGE } from "../http"

const noSleep = { sleep: async () => {}, random: () => 0.5 }

afterEach(() => vi.unstubAllGlobals())

describe("retryingFetch", () => {
  it("retries on 503 then succeeds, with backoff calls", async () => {
    const calls: number[] = []
    const fetcher = vi.fn(async () => (calls.push(1), calls.length < 3 ? new Response("x", { status: 503 }) : new Response("ok")))
    vi.stubGlobal("fetch", fetcher)
    const sleeps: number[] = []
    const res = await retryingFetch("https://s/x", {}, { ...noSleep, sleep: async (ms) => { sleeps.push(ms) } })
    expect(await res.text()).toBe("ok")
    expect(sleeps).toEqual([1000, 2000])
  })
  it("honours Retry-After on 429", async () => {
    let n = 0
    vi.stubGlobal("fetch", vi.fn(async () => (++n === 1 ? new Response("", { status: 429, headers: { "Retry-After": "7" } }) : new Response("ok"))))
    const sleeps: number[] = []
    await retryingFetch("https://s/x", {}, { ...noSleep, sleep: async (ms) => { sleeps.push(ms) } })
    expect(sleeps).toEqual([7000])
  })
  it("does not retry 400 and throws HttpError(retryable=false)", async () => {
    const f = vi.fn(async () => new Response("bad", { status: 400 }))
    vi.stubGlobal("fetch", f)
    await expect(retryingFetch("https://s/x", {}, noSleep)).rejects.toMatchObject({ status: 400, retryable: false } satisfies Partial<HttpError>)
    expect(f).toHaveBeenCalledTimes(1)
  })
  it("gives up after 6 attempts on network errors", async () => {
    const f = vi.fn(async () => { throw new Error("ECONNRESET") })
    vi.stubGlobal("fetch", f)
    await expect(retryingFetch("https://s/x", {}, noSleep)).rejects.toThrow(/ECONNRESET/)
    expect(f).toHaveBeenCalledTimes(6)
  })
  it("caps backoff at 60s", async () => {
    let n = 0
    vi.stubGlobal("fetch", vi.fn(async () => (++n < 6 ? new Response("", { status: 500 }) : new Response("ok"))))
    const sleeps: number[] = []
    await retryingFetch("https://s/x", {}, { ...noSleep, random: () => 1, sleep: async (ms) => { sleeps.push(ms) } })
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(60_000)
  })
})

describe("SyncClient", () => {
  it("sends bearer + runner header and parses ingest accepted", async () => {
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>
      expect(h.Authorization).toBe("Bearer sec")
      expect(h["x-migrate-runner"]).toBe("daemon@test")
      return Response.json({ accepted: 2 })
    })
    vi.stubGlobal("fetch", f)
    const c = new SyncClient("https://s", "sec", "daemon@test", noSleep)
    const r = await c.ingest("p", [{ id: "a", kind: "k", author: "x", clientTs: 1, payload: {} }, { id: "b", kind: "k", author: "x", clientTs: 1, payload: {} }])
    expect(r.accepted).toBe(2)
    expect(JSON.parse(String((f.mock.calls[0][1] as RequestInit).body))).toMatchObject({ projectId: "p", deferFileCounters: true, eventsOnly: false })
  })
  it("eventIds pages until more=false", async () => {
    let n = 0
    vi.stubGlobal("fetch", vi.fn(async () => (++n === 1 ? Response.json({ ids: ["a"], lastSeq: 5, more: true }) : Response.json({ ids: ["b"], lastSeq: 9, more: false }))))
    const c = new SyncClient("https://s", "sec", "r", noSleep)
    const pages: string[][] = []
    for await (const p of c.eventIds("p")) pages.push(p)
    expect(pages).toEqual([["a"], ["b"]])
  })
  it("eventIds runs onPage before each page fetch (per-page pacing)", async () => {
    let n = 0
    vi.stubGlobal("fetch", vi.fn(async () => (++n === 1 ? Response.json({ ids: ["a"], lastSeq: 5, more: true }) : Response.json({ ids: ["b"], lastSeq: 9, more: false }))))
    const c = new SyncClient("https://s", "sec", "r", noSleep)
    let paced = 0
    for await (const _p of c.eventIds("p", async () => { paced++ })) void _p
    expect(paced).toBe(2)
  })
  it("inbox asks for the capped page size", async () => {
    const f = vi.fn(async (_u: string) => Response.json({ items: [], last: undefined }))
    vi.stubGlobal("fetch", f)
    const c = new SyncClient("https://s", "sec", "r", noSleep)
    await c.inbox(undefined)
    expect(String(f.mock.calls[0][0])).toBe(`https://s/migrate/webhook/inbox?limit=${INBOX_PAGE}`)
    await c.inbox("cursor 1")
    expect(String(f.mock.calls[1][0])).toBe(`https://s/migrate/webhook/inbox?limit=${INBOX_PAGE}&after=cursor%201`)
  })
  it("orgTeamMaps maps orgs/groups from the real response shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      orgs: [{ legacyUuid: "org-uuid-1", id: 42, ownerUserId: 7 }],
      groups: [{ legacyUuid: "grp-uuid-1", id: 99 }],
    })))
    const c = new SyncClient("https://s", "sec", "r", noSleep)
    const { orgMap, teamMap } = await c.orgTeamMaps()
    expect(orgMap.get("org-uuid-1")).toEqual({ id: 42, ownerUserId: 7 })
    expect(teamMap.get("grp-uuid-1")).toBe(99)
  })
})

describe("GitLabClient", () => {
  it("listProjectsByActivity stops at the high-water mark", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([
      { id: 1, name: "a", path_with_namespace: "g/a", namespace: { full_path: "g" }, last_activity_at: "2026-09-08T10:00:00Z", http_url_to_repo: "u", default_branch: "main" },
      { id: 2, name: "b", path_with_namespace: "g/b", namespace: { full_path: "g" }, last_activity_at: "2026-09-01T00:00:00Z", http_url_to_repo: "u", default_branch: "main" },
    ], { headers: { "x-next-page": "" } })))
    const g = new GitLabClient("https://gl", "tok", noSleep)
    const out = []
    for await (const p of g.listProjectsByActivity("2026-09-05T00:00:00Z")) out.push(p.id)
    expect(out).toEqual([1])
  })
})
