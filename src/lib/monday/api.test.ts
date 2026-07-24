// Monday API client — asserts URL/method/headers/body shapes against the
// shared contract (monday-integration-contract.md), mirroring the fetch-mock
// style of src/lib/terminology/subscriptions-api.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  fetchMondayConnection,
  startMondayConnect,
  completeMondayOAuth,
  deleteMondayConnection,
  fetchMondayBoards,
  fetchMondayBoardStructure,
  fetchMondayLink,
  putMondayLink,
  patchMondayLink,
  deleteMondayLink,
  analyzeMondayMapping,
  syncMondayNow,
  MondayApiError,
} from "./api"
import type { MondayMapping } from "./types"

const ORIG = global.fetch
beforeEach(() => {
  global.fetch = vi.fn()
})
afterEach(() => {
  global.fetch = ORIG
})

const fetchMock = () => global.fetch as ReturnType<typeof vi.fn>

function ok(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

const CONFIG: MondayMapping = {
  version: 1,
  itemGranularity: "project",
  columns: [{ columnId: "numbers_1", columnType: "numbers", metric: "completion_pct" }],
}

describe("fetchMondayConnection", () => {
  it("GETs the org connection with the Bearer JWT", async () => {
    fetchMock().mockResolvedValueOnce(ok({ connected: true, account: { id: "1", slug: "acme", userName: "Ann" } }))
    const res = await fetchMondayConnection("jwt", 7)
    expect(res.connected).toBe(true)
    const [url, init] = fetchMock().mock.calls[0]
    expect(url).toMatch(/\/api\/v2\/monday\/orgs\/7\/connection$/)
    expect(init.method).toBeUndefined() // plain GET
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt")
  })

  it("throws MondayApiError with server error message on failure", async () => {
    fetchMock().mockResolvedValueOnce(ok({ error: "not a member" }, 403))
    await expect(fetchMondayConnection("jwt", 7)).rejects.toMatchObject({
      name: "MondayApiError",
      status: 403,
      message: "not a member",
    })
  })
})

describe("startMondayConnect", () => {
  it("POSTs backTo and returns the OAuth url", async () => {
    fetchMock().mockResolvedValueOnce(ok({ url: "https://auth.monday.com/oauth2/authorize?x=1" }))
    const res = await startMondayConnect("jwt", 7, "/settings/monday")
    expect(res.url).toContain("auth.monday.com")
    const [url, init] = fetchMock().mock.calls[0]
    expect(url).toMatch(/\/api\/v2\/monday\/orgs\/7\/connection\/start$/)
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body as string)).toEqual({ backTo: "/settings/monday" })
  })

  it("sends an empty body when backTo is omitted", async () => {
    fetchMock().mockResolvedValueOnce(ok({ url: "https://auth.monday.com/x" }))
    await startMondayConnect("jwt", 7)
    expect(JSON.parse(fetchMock().mock.calls[0][1].body as string)).toEqual({})
  })
})

describe("completeMondayOAuth", () => {
  it("GETs the callback with code+state as query params and no auth header", async () => {
    fetchMock().mockResolvedValueOnce(ok({ ok: true, backTo: "/settings/monday" }))
    const res = await completeMondayOAuth("the-code", "the-state")
    expect(res).toEqual({ ok: true, backTo: "/settings/monday" })
    const call = fetchMock().mock.calls[0]
    expect(call[0]).toMatch(/\/api\/v2\/monday\/oauth\/callback\?code=the-code&state=the-state$/)
    expect(call[1]).toBeUndefined() // plain GET, no headers
  })

  it("returns ok:false with the server reason on failure", async () => {
    fetchMock().mockResolvedValueOnce(ok({ ok: false, reason: "state expired" }, 400))
    const res = await completeMondayOAuth("c", "s")
    expect(res).toEqual({ ok: false, reason: "state expired" })
  })

  it("returns ok:false (never throws) on network error — the code is single-use", async () => {
    fetchMock().mockRejectedValueOnce(new Error("offline"))
    const res = await completeMondayOAuth("c", "s")
    expect(res.ok).toBe(false)
  })
})

describe("deleteMondayConnection", () => {
  it("DELETEs the connection", async () => {
    fetchMock().mockResolvedValueOnce(ok({ ok: true }))
    await deleteMondayConnection("jwt", 7)
    const [url, init] = fetchMock().mock.calls[0]
    expect(url).toMatch(/\/api\/v2\/monday\/orgs\/7\/connection$/)
    expect(init.method).toBe("DELETE")
  })
})

describe("fetchMondayBoards", () => {
  it("unwraps { boards }", async () => {
    fetchMock().mockResolvedValueOnce(
      ok({ boards: [{ id: "b1", name: "Translation", workspace: { id: "w", name: "Main" } }] }),
    )
    const res = await fetchMondayBoards("jwt", 7)
    expect(res).toHaveLength(1)
    expect(res[0].name).toBe("Translation")
    expect(fetchMock().mock.calls[0][0]).toMatch(/\/api\/v2\/monday\/orgs\/7\/boards$/)
  })

  it("returns [] when boards is absent", async () => {
    fetchMock().mockResolvedValueOnce(ok({}))
    expect(await fetchMondayBoards("jwt", 7)).toEqual([])
  })
})

describe("fetchMondayBoardStructure", () => {
  it("GETs the structure for a board", async () => {
    fetchMock().mockResolvedValueOnce(ok({ columns: [], groups: [] }))
    await fetchMondayBoardStructure("jwt", 7, "b1")
    expect(fetchMock().mock.calls[0][0]).toMatch(/\/api\/v2\/monday\/orgs\/7\/boards\/b1\/structure$/)
  })
})

describe("fetchMondayLink", () => {
  it("GETs the project link status", async () => {
    fetchMock().mockResolvedValueOnce(ok({ linked: false }))
    const res = await fetchMondayLink("jwt", "p1")
    expect(res.linked).toBe(false)
    expect(fetchMock().mock.calls[0][0]).toMatch(/\/api\/v2\/monday\/projects\/p1\/link$/)
  })
})

describe("putMondayLink", () => {
  it("PUTs boardId + config and returns { link, warnings }", async () => {
    fetchMock().mockResolvedValueOnce(
      ok({ link: { id: "l1", boardId: "b1", enabled: true, config: CONFIG }, warnings: ["dropped col x"] }),
    )
    const res = await putMondayLink("jwt", "p1", { boardId: "b1", boardName: "T", config: CONFIG })
    expect(res.link.id).toBe("l1")
    expect(res.warnings).toEqual(["dropped col x"])
    const [url, init] = fetchMock().mock.calls[0]
    expect(url).toMatch(/\/api\/v2\/monday\/projects\/p1\/link$/)
    expect(init.method).toBe("PUT")
    expect(JSON.parse(init.body as string)).toEqual({ boardId: "b1", boardName: "T", config: CONFIG })
  })

  it("defaults warnings to [] when absent", async () => {
    fetchMock().mockResolvedValueOnce(ok({ link: { id: "l1" } }))
    const res = await putMondayLink("jwt", "p1", { boardId: "b1", config: CONFIG })
    expect(res.warnings).toEqual([])
  })
})

describe("patchMondayLink", () => {
  it("PATCHes enabled and unwraps a { link } envelope", async () => {
    fetchMock().mockResolvedValueOnce(ok({ link: { id: "l1", enabled: false } }))
    const res = await patchMondayLink("jwt", "p1", { enabled: false })
    expect(res.enabled).toBe(false)
    const [, init] = fetchMock().mock.calls[0]
    expect(init.method).toBe("PATCH")
    expect(JSON.parse(init.body as string)).toEqual({ enabled: false })
  })

  it("accepts a bare link object response", async () => {
    fetchMock().mockResolvedValueOnce(ok({ id: "l1", enabled: true, config: CONFIG }))
    const res = await patchMondayLink("jwt", "p1", { config: CONFIG })
    expect(res.id).toBe("l1")
  })
})

describe("deleteMondayLink", () => {
  it("DELETEs the link", async () => {
    fetchMock().mockResolvedValueOnce(ok({ ok: true }))
    await deleteMondayLink("jwt", "p1")
    expect(fetchMock().mock.calls[0][1].method).toBe("DELETE")
  })
})

describe("analyzeMondayMapping", () => {
  it("POSTs boardId (+ message + currentConfig when reconfiguring)", async () => {
    fetchMock().mockResolvedValueOnce(ok({ proposal: CONFIG, summary: "Maps completion to Numbers." }))
    const res = await analyzeMondayMapping("jwt", "p1", {
      boardId: "b1",
      message: "track validated instead",
      currentConfig: CONFIG,
    })
    expect(res.summary).toContain("Numbers")
    const [url, init] = fetchMock().mock.calls[0]
    expect(url).toMatch(/\/api\/v2\/monday\/projects\/p1\/analyze$/)
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body as string)).toEqual({
      boardId: "b1",
      message: "track validated instead",
      currentConfig: CONFIG,
    })
  })

  it("surfaces server errors as MondayApiError", async () => {
    fetchMock().mockResolvedValueOnce(ok({ error: "board not found" }, 404))
    await expect(analyzeMondayMapping("jwt", "p1", { boardId: "nope" })).rejects.toBeInstanceOf(MondayApiError)
  })
})

describe("syncMondayNow", () => {
  it("POSTs to the sync endpoint and returns the result", async () => {
    fetchMock().mockResolvedValueOnce(ok({ ok: true, pushed: true, itemsUpserted: 3 }))
    const res = await syncMondayNow("jwt", "p1")
    expect(res).toEqual({ ok: true, pushed: true, itemsUpserted: 3 })
    const [url, init] = fetchMock().mock.calls[0]
    expect(url).toMatch(/\/api\/v2\/monday\/projects\/p1\/sync$/)
    expect(init.method).toBe("POST")
  })
})
