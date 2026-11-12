import { describe, it, expect, vi, afterEach } from "vitest"
import {
  fetchMemberLaneAssignments,
  fetchMemberScopes,
  fetchMyScopeGrant,
  fetchProjectLaneStaffing,
  isInMemberScope,
  putMemberScopes,
  type MemberScope,
} from "./member-scopes"

const API = "https://api.example.com"

afterEach(() => vi.restoreAllMocks())

describe("fetchMemberScopes", () => {
  it("GETs the scopes endpoint with auth headers and returns parsed scopes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ scopes: [{ kind: "lane", value: "fr" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
    const got = await fetchMemberScopes("jwt-123", "proj-1", 42, API)
    expect(got).toEqual([{ kind: "lane", value: "fr" }])

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe(`${API}/api/v2/projects/proj-1/members/42/scopes`)
    expect(init?.method).toBeUndefined()
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer jwt-123")
  })

  it("encodes projectId and userId in the URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ scopes: [] }), { status: 200 }),
    )
    await fetchMemberScopes("jwt", "proj with space", 7, API)
    const [url] = fetchSpy.mock.calls[0]
    expect(url).toBe(`${API}/api/v2/projects/proj%20with%20space/members/7/scopes`)
  })

  it("defaults to an empty array when scopes is absent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    )
    expect(await fetchMemberScopes("jwt", "p1", 1, API)).toEqual([])
  })

  it("returns null on 403", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 403 }))
    expect(await fetchMemberScopes("jwt", "p1", 1, API)).toBeNull()
  })

  it("returns null on 404", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }))
    expect(await fetchMemberScopes("jwt", "p1", 1, API)).toBeNull()
  })

  it("returns null on network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))
    expect(await fetchMemberScopes("jwt", "p1", 1, API)).toBeNull()
  })
})

describe("putMemberScopes", () => {
  it("PUTs the replace-set with auth headers and JSON body, returns saved scopes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ scopes: [{ kind: "file", value: "f1" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
    const scopes: MemberScope[] = [{ kind: "file", value: "f1" }]
    const got = await putMemberScopes("jwt-123", "proj-1", 42, scopes, API)
    expect(got).toEqual({ scopes: [{ kind: "file", value: "f1" }], laneNames: {} })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe(`${API}/api/v2/projects/proj-1/members/42/scopes`)
    expect(init?.method).toBe("PUT")
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer jwt-123")
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json")
    expect(JSON.parse(init?.body as string)).toEqual({ scopes })
  })

  it("returns an empty view when the server omits scopes on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    )
    expect(await putMemberScopes("jwt", "p1", 1, [], API)).toEqual({ scopes: [], laneNames: {} })
  })

  // AQU-1607: the lanes a member holds AFTER a save are not the ones they
  // held before it, so the save's own names are the only ones that can label
  // a lane just granted. Dropping them printed the lane's id in the chip.
  it("keeps the lane names the save answers with", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          scopes: [{ kind: "lane", value: "4b67177e" }],
          laneNames: { "4b67177e": "Spanish B" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
    const got = await putMemberScopes("jwt", "p1", 1, [{ kind: "lane", value: "4b67177e" }], API)
    expect(got).toEqual({
      scopes: [{ kind: "lane", value: "4b67177e" }],
      laneNames: { "4b67177e": "Spanish B" },
    })
  })

  it("surfaces the values a refused lane scope named", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "lane scopes must name one lane of this project",
          ambiguous: ["Spanish"],
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    )
    await expect(
      putMemberScopes("jwt", "p1", 1, [{ kind: "lane", value: "Spanish" }], API),
    ).rejects.toThrow("lane scopes must name one lane of this project: Spanish")
  })

  it("throws with the server's error message on 400", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ error: "scopes are for contributor/reviewer roles" }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    )
    await expect(putMemberScopes("jwt", "p1", 1, [], API)).rejects.toThrow(
      "scopes are for contributor/reviewer roles",
    )
  })

  it("throws with a generic HTTP status message when the error body isn't JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 403 }))
    await expect(putMemberScopes("jwt", "p1", 1, [], API)).rejects.toThrow("HTTP 403")
  })

  it("propagates network errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))
    await expect(putMemberScopes("jwt", "p1", 1, [], API)).rejects.toThrow("offline")
  })
})

const allowed = (scopes: MemberScope[], fileId = "file-1", lane = "fr") =>
  isInMemberScope(scopes, fileId, lane)

describe("isInMemberScope", () => {
  it("fails open when scopes are absent so the server remains authoritative", () => {
    expect(isInMemberScope(undefined, "file-1", "fr")).toBe(true)
    expect(isInMemberScope(null, "file-1", "fr")).toBe(true)
    expect(allowed([])).toBe(true)
  })

  it("requires the active lane to match one of the member's lane scopes", () => {
    const scopes: MemberScope[] = [
      { kind: "lane", value: "fr" },
      { kind: "lane", value: "es" },
    ]
    expect(allowed(scopes, "file-1", "fr")).toBe(true)
    expect(allowed(scopes, "file-1", "de")).toBe(false)
  })

  it("requires the file to match one of the member's file scopes", () => {
    const scopes: MemberScope[] = [
      { kind: "file", value: "file-1" },
      { kind: "file", value: "file-2" },
    ]
    expect(allowed(scopes, "file-2", "fr")).toBe(true)
    expect(allowed(scopes, "file-3", "fr")).toBe(false)
  })

  it("combines file and lane scope categories with AND semantics", () => {
    const scopes: MemberScope[] = [
      { kind: "file", value: "file-1" },
      { kind: "lane", value: "fr" },
    ]
    expect(allowed(scopes, "file-1", "fr")).toBe(true)
    expect(allowed(scopes, "file-2", "fr")).toBe(false)
    expect(allowed(scopes, "file-1", "es")).toBe(false)
  })
})

// AQU-581 review: a guest can't read the org's settings, so the lane-assignment
// setting reaches them with their own scopes.
describe("fetchMyScopeGrant", () => {
  const reply = (body: unknown, status = 200) =>
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    )

  it("GETs `me` and returns the scopes with the org's lane-assignment setting", async () => {
    const spy = reply({ scopes: [{ kind: "lane", value: "es" }], allowScopedLaneAssignment: true })
    expect(await fetchMyScopeGrant("jwt", "p1", API)).toEqual({
      scopes: [{ kind: "lane", value: "es" }],
      allowScopedLaneAssignment: true,
    })
    expect(spy.mock.calls[0][0]).toBe(`${API}/api/v2/projects/p1/members/me/scopes`)
  })

  it("reports the setting as unknown (null) when an older server leaves it out", async () => {
    reply({ scopes: [] })
    expect(await fetchMyScopeGrant("jwt", "p1", API)).toEqual({ scopes: [], allowScopedLaneAssignment: null })
  })

  it("returns null on an error status", async () => {
    reply({ error: "no access to project" }, 403)
    expect(await fetchMyScopeGrant("jwt", "p1", API)).toBeNull()
  })
})

// AQU-1999 — the seam between the route and the removal that acts on what it
// says. The bodies here are exactly the shapes auth-worker's
// `member-lane-assignments.test.ts` asserts it returns, so the two halves of
// the contract are pinned against the same wire shape.
describe("fetchMemberLaneAssignments", () => {
  const ROW = { assignmentId: "as-1", fileId: "f1", scopeLabel: "Acts 1" }

  it("GETs the lane's assignments with the lane as a query param", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ assignments: [ROW] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    expect(await fetchMemberLaneAssignments("jwt-123", "proj-1", 42, "ln-es1", API)).toEqual([ROW])

    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe(`${API}/api/v2/projects/proj-1/members/42/lane-assignments?lane=ln-es1`)
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer jwt-123")
  })

  it("encodes a lane value that needs it", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ assignments: [] }), { status: 200 }),
    )
    await fetchMemberLaneAssignments("jwt", "p1", 7, "Spanish \u2014 Mexico", API)
    const [url] = fetchSpy.mock.calls[0]
    expect(url).toBe(
      `${API}/api/v2/projects/p1/members/7/lane-assignments?lane=Spanish%20%E2%80%94%20Mexico`,
    )
  })

  it("reads an empty list as nothing open \u2014 the one-press removal", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ assignments: [] }), { status: 200 }),
    )
    expect(await fetchMemberLaneAssignments("jwt", "p1", 1, "ln-es1", API)).toEqual([])
  })

  // null is "couldn't tell", which the caller must not read as "nothing open":
  // that is how an assignment ends up stranded in an unreachable lane.
  it("returns null on a refusal, a malformed body and a network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 403 }))
    expect(await fetchMemberLaneAssignments("jwt", "p1", 1, "ln-es1", API)).toBeNull()

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 400 }))
    expect(await fetchMemberLaneAssignments("jwt", "p1", 1, "nope", API)).toBeNull()

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    )
    expect(await fetchMemberLaneAssignments("jwt", "p1", 1, "ln-es1", API)).toBeNull()

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))
    expect(await fetchMemberLaneAssignments("jwt", "p1", 1, "ln-es1", API)).toBeNull()
  })

  it("drops a row with no file id \u2014 there is nothing to route an unassign through", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ assignments: [ROW, { assignmentId: "as-2", scopeLabel: "Acts 2" }] }),
        { status: 200 },
      ),
    )
    expect(await fetchMemberLaneAssignments("jwt", "p1", 1, "ln-es1", API)).toEqual([ROW])
  })
})

describe("fetchProjectLaneStaffing (AQU-2047)", () => {
  it("reads staffing and each attached team's lane checks from one response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          laneIds: ["lane-zh"],
          teamLanes: [
            { lanesExplicit: true, laneIds: ["lane-fr"] },
            { lanesExplicit: false, laneIds: ["lane-sv"] },
          ],
        }),
        { status: 200 },
      ),
    )
    const read = await fetchProjectLaneStaffing("jwt", "p1", API)
    expect(read?.staffedLaneIds).toEqual(new Set(["lane-zh"]))
    // A non-explicit team is tied to every current lane; a leftover laneIds
    // list on that entry is not its set.
    expect(read?.teamLanes).toEqual([
      { lanesExplicit: true, laneIds: ["lane-fr"] },
      { lanesExplicit: false },
    ])
  })

  it("treats a missing teamLanes as unknown, and an empty list as no attached team", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ laneIds: ["lane-fr"] }), { status: 200 }),
    )
    expect(await fetchProjectLaneStaffing("jwt", "p1", API)).toEqual({
      staffedLaneIds: new Set(["lane-fr"]),
      teamLanes: null,
    })

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ laneIds: [], teamLanes: [] }), { status: 200 }),
    )
    expect(await fetchProjectLaneStaffing("jwt", "p1", API)).toEqual({
      staffedLaneIds: new Set(),
      teamLanes: [],
    })
  })

  it("treats a missing laneIds as unknown staffing, even when team lanes arrived", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ teamLanes: [] }), { status: 200 }),
    )
    expect(await fetchProjectLaneStaffing("jwt", "p1", API)).toEqual({
      staffedLaneIds: null,
      teamLanes: [],
    })
  })

  it("returns null on a refusal or a network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 403 }))
    expect(await fetchProjectLaneStaffing("jwt", "p1", API)).toBeNull()

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))
    expect(await fetchProjectLaneStaffing("jwt", "p1", API)).toBeNull()
  })
})
