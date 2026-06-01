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
import { getWorkload, getMyAssignments, createAssignment, AssignmentEmitError } from "./assignments"

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
  it("GETs the workload endpoint with auth and returns the array", async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonRes({ workload: [{ userId: 2, username: "anna", openAssignments: 1, cellsTotal: 3, cellsDone: 2 }] }),
    )
    const out = await getWorkload("jwt", 1)
    expect(mockFetchWithTimeout).toHaveBeenCalledWith(
      "https://auth.test/api/v2/orgs/1/assignments/workload",
      { headers: { Authorization: "Bearer jwt" } },
    )
    expect(out).toEqual([{ userId: 2, username: "anna", openAssignments: 1, cellsTotal: 3, cellsDone: 2 }])
  })

  it("throws on non-ok", async () => {
    mockFetchWithTimeout.mockResolvedValue(jsonRes({}, false, 403))
    await expect(getWorkload("jwt", 1)).rejects.toThrow(/HTTP 403/)
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
