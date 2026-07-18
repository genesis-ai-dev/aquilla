import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Mocks — inline vi.fn() in the factory, then vi.mocked() the imported symbol
// (avoids the "spread argument must have a tuple type" tsc error from the
// (...a) => fn(...a) wrapper pattern).
vi.mock("../frontier/auth", () => ({ FRONTIER_BASE: "https://auth.test" }))
vi.mock("../frontier/orgs", () => ({ fetchWithTimeout: vi.fn() }))
vi.mock("./sync-token", () => ({ fetchSyncToken: vi.fn() }))
vi.mock("./sync-worker-url", () => ({ syncWorkerHttpOrigin: () => "https://sync.test" }))

import { fetchWithTimeout } from "../frontier/orgs"
import { fetchSyncToken } from "./sync-token"
import { getWorkload, getMyAssignments, getFileChapters, createAssignment, createBulkFileAssignments, unassignAssignment, AssignmentEmitError } from "./assignments"

const mockFetchWithTimeout = vi.mocked(fetchWithTimeout)
const mockFetchSyncToken = vi.mocked(fetchSyncToken)

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllGlobals())

describe("getWorkload", () => {
  it("GETs the workload endpoint with auth and returns one row per assignment, with project attribution", async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonRes({
        assignments: [
          { assignmentId: "a1", projectId: "pa", projectName: "John", fileId: "f1", assigneeUserId: 2, username: "anna", scopeLabel: "Genesis", cellsTotal: 3, cellsDone: 2, deadline: null },
        ],
      }),
    )
    const out = await getWorkload("jwt", 1)
    expect(mockFetchWithTimeout).toHaveBeenCalledWith(
      "https://auth.test/api/v2/orgs/1/assignments/workload",
      { headers: { Authorization: "Bearer jwt" } },
    )
    expect(out).toEqual([
      { assignmentId: "a1", projectId: "pa", projectName: "John", fileId: "f1", assigneeUserId: 2, username: "anna", scopeLabel: "Genesis", cellsTotal: 3, cellsDone: 2, deadline: null },
    ])
  })

  it("throws on non-ok with a human message, not 'HTTP 403'", async () => {
    mockFetchWithTimeout.mockResolvedValue(jsonRes({}, false, 403))
    const err = await getWorkload("jwt", 1).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toMatch(/HTTP\s*403/)
    expect((err as Error).name).toBe("UserError")
  })
})

describe("getMyAssignments", () => {
  it("GETs the inbox endpoint and returns the array", async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonRes({
        assignments: [
          { assignmentId: "a1", projectId: "p1", scopeKind: "books", scopeLabel: "Genesis", deadline: null, note: null, cellsTotal: 3, cellsDone: 2, createdAt: 1 },
        ],
      }),
    )
    const out = await getMyAssignments("jwt", "p1")
    expect(mockFetchWithTimeout).toHaveBeenCalledWith(
      "https://auth.test/api/v2/projects/p1/assignments/mine",
      { headers: { Authorization: "Bearer jwt" } },
    )
    expect(out).toHaveLength(1)
    expect(out[0].assignmentId).toBe("a1")
  })
})

describe("createAssignment", () => {
  it("POSTs one assignment.create event with the sync token and returns the new id", async () => {
    mockFetchSyncToken.mockResolvedValue({ token: "synctoken" } as Awaited<ReturnType<typeof fetchSyncToken>>)
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const parsed = JSON.parse(init.body as string)
      return jsonRes({ accepted: [{ id: parsed.events[0].id }], rejected: [] })
    })
    vi.stubGlobal("fetch", fetchMock)

    const id = await createAssignment({
      jwt: "jwt",
      projectId: "p1",
      fileId: "f1",
      author: "wendi",
      assigneeUserId: 2,
      scope: [{ fileId: "f1" }],
      scopeKind: "books",
      scopeLabel: "Genesis",
      deadline: "2026-06-30",
    })

    expect(typeof id).toBe("string")
    expect(mockFetchSyncToken).toHaveBeenCalledWith("jwt", "p1", "f1")
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://sync.test/events")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer synctoken")
    const sent = JSON.parse(init.body as string)
    expect(sent.events).toHaveLength(1)
    expect(sent.events[0].kind).toBe("assignment.create")
    expect(sent.events[0].fileId).toBe("f1")
    expect(sent.events[0].parentId).toBeNull()
    expect(sent.events[0].payload).toMatchObject({
      assignmentId: id,
      assigneeUserId: 2,
      scopeKind: "books",
      scope: [{ fileId: "f1" }],
      scopeLabel: "Genesis",
      deadline: "2026-06-30",
    })
  })

  // AQU-538 (§3.5): the lane rides in the payload only when non-'' — the
  // default lane is omitted on the wire (same convention as every lane field).
  it("includes targetLang in the payload when non-'', and omits it when '' or absent", async () => {
    mockFetchSyncToken.mockResolvedValue({ token: "synctoken" } as Awaited<ReturnType<typeof fetchSyncToken>>)
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const parsed = JSON.parse(init.body as string)
        bodies.push(parsed.events[0].payload)
        return jsonRes({ accepted: [{ id: parsed.events[0].id }], rejected: [] })
      }),
    )

    await createAssignment({
      jwt: "jwt", projectId: "p1", fileId: "f1", author: "wendi", assigneeUserId: 2,
      scope: [{ fileId: "f1" }], scopeKind: "books", scopeLabel: "Genesis", targetLang: "es",
    })
    await createAssignment({
      jwt: "jwt", projectId: "p1", fileId: "f1", author: "wendi", assigneeUserId: 2,
      scope: [{ fileId: "f1" }], scopeKind: "books", scopeLabel: "Genesis", targetLang: "",
    })
    await createAssignment({
      jwt: "jwt", projectId: "p1", fileId: "f1", author: "wendi", assigneeUserId: 2,
      scope: [{ fileId: "f1" }], scopeKind: "books", scopeLabel: "Genesis",
    })

    expect(bodies[0].targetLang).toBe("es")
    expect("targetLang" in bodies[1]).toBe(false)
    expect("targetLang" in bodies[2]).toBe(false)
  })

  it("throws AssignmentEmitError when the server rejects (e.g. role too low → 403)", async () => {
    mockFetchSyncToken.mockResolvedValue({ token: "synctoken" } as Awaited<ReturnType<typeof fetchSyncToken>>)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes({ accepted: [], rejected: [{ id: "x", status: 403, reason: "role too low for assignment.create" }] })),
    )
    await expect(
      createAssignment({ jwt: "jwt", projectId: "p1", fileId: "f1", author: "anna", assigneeUserId: 2, scope: [{ fileId: "f1" }], scopeKind: "books", scopeLabel: "Genesis" }),
    ).rejects.toThrow(/role too low/)
  })

  it("throws when the POST is not ok", async () => {
    mockFetchSyncToken.mockResolvedValue({ token: "synctoken" } as Awaited<ReturnType<typeof fetchSyncToken>>)
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({}, false, 500)))
    await expect(
      createAssignment({ jwt: "jwt", projectId: "p1", fileId: "f1", author: "wendi", assigneeUserId: 2, scope: [{ fileId: "f1" }], scopeKind: "books", scopeLabel: "Genesis" }),
    ).rejects.toBeInstanceOf(AssignmentEmitError)
  })
})

// AQU-497: bulk "assign a whole season" — one assignment.create event PER
// file (not one event whose scope[] spans every file), so each file keeps
// its own cells_total/cells_done row and its own assignmentId. That's what
// makes "individual units remain individually removable afterward" true —
// unassignAssignment (below) only ever closes ONE assignment_id.
describe("createBulkFileAssignments", () => {
  it("emits one event per entry, all sharing the same deadline and assignee, each scoped to exactly its own file", async () => {
    mockFetchSyncToken.mockResolvedValue({ token: "synctoken" } as Awaited<ReturnType<typeof fetchSyncToken>>)
    const posted: { fileId: string; payload: Record<string, unknown> }[] = []
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const parsed = JSON.parse(init.body as string)
      posted.push({ fileId: parsed.events[0].fileId, payload: parsed.events[0].payload })
      return jsonRes({ accepted: [{ id: parsed.events[0].id }], rejected: [] })
    })
    vi.stubGlobal("fetch", fetchMock)

    const results = await createBulkFileAssignments({
      jwt: "jwt",
      projectId: "p1",
      author: "wendi",
      assigneeUserId: 2,
      entries: [
        { fileId: "f1", scopeLabel: "Season 1 · Genesis" },
        { fileId: "f2", scopeLabel: "Season 1 · Exodus" },
        { fileId: "f3", scopeLabel: "Season 1 · Leviticus" },
      ],
      deadline: "2026-08-15",
    })

    // Unit count: one result per file, matching the season's contents.
    expect(results).toHaveLength(3)
    expect(results.every((r) => r.assignmentId && !r.error)).toBe(true)
    // Distinct assignment ids — three real rows, not one shared assignment.
    expect(new Set(results.map((r) => r.assignmentId)).size).toBe(3)

    expect(posted).toHaveLength(3)
    expect(posted.map((e) => e.fileId).sort()).toEqual(["f1", "f2", "f3"])
    for (const e of posted) {
      // Each event's scope covers ONLY its own file — never the whole batch.
      expect(e.payload.scope).toHaveLength(1)
      expect(e.payload.deadline).toBe("2026-08-15")
      expect(e.payload.assigneeUserId).toBe(2)
    }
  })

  it("reports a per-file error without discarding the entries that succeeded", async () => {
    mockFetchSyncToken.mockResolvedValue({ token: "synctoken" } as Awaited<ReturnType<typeof fetchSyncToken>>)
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const parsed = JSON.parse(init.body as string)
      if (parsed.events[0].fileId === "f2") {
        return jsonRes({ accepted: [], rejected: [{ id: parsed.events[0].id, status: 403, reason: "role too low for assignment.create" }] })
      }
      return jsonRes({ accepted: [{ id: parsed.events[0].id }], rejected: [] })
    })
    vi.stubGlobal("fetch", fetchMock)

    const results = await createBulkFileAssignments({
      jwt: "jwt",
      projectId: "p1",
      author: "wendi",
      assigneeUserId: 2,
      entries: [
        { fileId: "f1", scopeLabel: "Genesis" },
        { fileId: "f2", scopeLabel: "Exodus" },
      ],
    })

    const byFile = Object.fromEntries(results.map((r) => [r.fileId, r]))
    expect(byFile.f1.assignmentId).toBeTruthy()
    expect(byFile.f1.error).toBeUndefined()
    expect(byFile.f2.assignmentId).toBeUndefined()
    expect(byFile.f2.error).toMatch(/role too low/)
  })
})

describe("unassignAssignment", () => {
  it("POSTs one assignment.unassign event with the sync token, regardless of progress (AQU-494)", async () => {
    mockFetchSyncToken.mockResolvedValue({ token: "synctoken" } as Awaited<ReturnType<typeof fetchSyncToken>>)
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const parsed = JSON.parse(init.body as string)
      return jsonRes({ accepted: [{ id: parsed.events[0].id }], rejected: [] })
    })
    vi.stubGlobal("fetch", fetchMock)

    await unassignAssignment({
      jwt: "jwt",
      projectId: "p1",
      fileId: "f1",
      author: "wendi",
      assignmentId: "as-anna",
    })

    expect(mockFetchSyncToken).toHaveBeenCalledWith("jwt", "p1", "f1")
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://sync.test/events")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer synctoken")
    const sent = JSON.parse(init.body as string)
    expect(sent.events).toHaveLength(1)
    expect(sent.events[0].kind).toBe("assignment.unassign")
    expect(sent.events[0].payload).toEqual({ assignmentId: "as-anna" })
  })

  it("throws AssignmentEmitError when the server rejects (e.g. role too low → 403)", async () => {
    mockFetchSyncToken.mockResolvedValue({ token: "synctoken" } as Awaited<ReturnType<typeof fetchSyncToken>>)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes({ accepted: [], rejected: [{ id: "x", status: 403, reason: "role too low for assignment.unassign" }] })),
    )
    await expect(
      unassignAssignment({ jwt: "jwt", projectId: "p1", fileId: "f1", author: "anna", assignmentId: "as-anna" }),
    ).rejects.toThrow(/role too low/)
  })

  it("throws when the POST is not ok", async () => {
    mockFetchSyncToken.mockResolvedValue({ token: "synctoken" } as Awaited<ReturnType<typeof fetchSyncToken>>)
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({}, false, 500)))
    await expect(
      unassignAssignment({ jwt: "jwt", projectId: "p1", fileId: "f1", author: "wendi", assignmentId: "as-anna" }),
    ).rejects.toBeInstanceOf(AssignmentEmitError)
  })
})

describe("getFileChapters", () => {
  it("GETs the chapters endpoint and returns the array", async () => {
    mockFetchWithTimeout.mockResolvedValue(jsonRes({ chapters: ["GEN 1", "GEN 2", "GEN 10"] }))
    const out = await getFileChapters("jwt", "p1", "f1")
    expect(mockFetchWithTimeout).toHaveBeenCalledWith(
      "https://auth.test/api/v2/projects/p1/files/f1/chapters",
      { headers: { Authorization: "Bearer jwt" } },
    )
    expect(out).toEqual(["GEN 1", "GEN 2", "GEN 10"])
  })

  it("throws on non-ok with a human message, not 'HTTP 403'", async () => {
    mockFetchWithTimeout.mockResolvedValue(jsonRes({}, false, 403))
    const err = await getFileChapters("jwt", "p1", "f1").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toMatch(/HTTP\s*403/)
    expect((err as Error).name).toBe("UserError")
  })
})
