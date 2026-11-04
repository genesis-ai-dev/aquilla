/**
 * memory-api.test.ts — fetch-client contract tests for the agent memory
 * routes (§3). Verifies request shape (URL, method, headers, body) and that
 * non-OK responses surface the RIGHT typed error: generic MemoryApiError for
 * an ordinary failure, HumanEditProtectedError for its 403 code,
 * VersionConflictError for a 409 with `currentVersion` carried through.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  HumanEditProtectedError,
  MemoryApiError,
  VersionConflictError,
  editAgentMemory,
  listAgentMemories,
  proposeAgentMemory,
  reviewAgentMemory,
  type AgentMemory,
} from "./memory-api"

const JWT = "jwt-token"
const PROJECT_ID = "proj-1"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function errorResponse(status: number, code?: string, message = "boom"): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

const MEMORY: AgentMemory = {
  id: "mem-1",
  projectId: PROJECT_ID,
  path: "observations/foo.md",
  content: "some content",
  status: "proposed",
  humanEdited: false,
  rationale: "because",
  provenance: { runId: "run-1" },
  createdBy: "alice",
  reviewedBy: null,
  version: 1,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("listAgentMemories", () => {
  it("GETs with the status filter and Authorization header", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ memories: [MEMORY] }))
    const result = await listAgentMemories(JWT, PROJECT_ID, "proposed")
    expect(result).toEqual([MEMORY])
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain(`/projects/${PROJECT_ID}/agent-memory?status=proposed`)
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${JWT}`)
  })

  it("omits the query string when no status is given", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ memories: [] }))
    await listAgentMemories(JWT, PROJECT_ID)
    const [url] = fetchMock.mock.calls[0]
    expect(String(url)).not.toContain("?status=")
  })

  it("throws a generic MemoryApiError on a plain failure", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(500, undefined, "server exploded"))
    await expect(listAgentMemories(JWT, PROJECT_ID)).rejects.toThrow(MemoryApiError)
  })
})

describe("proposeAgentMemory", () => {
  it("POSTs the path/content/rationale body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(MEMORY, 201))
    const result = await proposeAgentMemory(JWT, PROJECT_ID, {
      path: "observations/foo.md",
      content: "some content",
      rationale: "because",
    })
    expect(result).toEqual(MEMORY)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body as string)).toEqual({
      path: "observations/foo.md",
      content: "some content",
      rationale: "because",
    })
  })
})

describe("reviewAgentMemory", () => {
  it("POSTs {action} to the review endpoint", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...MEMORY, status: "approved" }))
    const result = await reviewAgentMemory(JWT, PROJECT_ID, MEMORY.id, "approve")
    expect(result.status).toBe("approved")
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain(`/agent-memory/${MEMORY.id}/review`)
    expect(JSON.parse(init.body as string)).toEqual({ action: "approve" })
  })
})

describe("editAgentMemory", () => {
  it("PATCHes content and returns the updated (human-edited) row", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...MEMORY, content: "edited", humanEdited: true, version: 2 }))
    const result = await editAgentMemory(JWT, PROJECT_ID, MEMORY.id, "edited")
    expect(result.humanEdited).toBe(true)
    expect(result.version).toBe(2)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe("PATCH")
  })

  it("throws HumanEditProtectedError on 403 human_edit_protected", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(403, "human_edit_protected"))
    await expect(editAgentMemory(JWT, PROJECT_ID, MEMORY.id, "x")).rejects.toBeInstanceOf(
      HumanEditProtectedError,
    )
  })
})

describe("versioned-write conflicts", () => {
  it("throws VersionConflictError with currentVersion on 409", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "stale" }, currentVersion: 9 }), { status: 409 }),
    )
    try {
      await editAgentMemory(JWT, PROJECT_ID, MEMORY.id, "x")
      expect.unreachable("expected a VersionConflictError")
    } catch (err) {
      expect(err).toBeInstanceOf(VersionConflictError)
      expect((err as VersionConflictError).currentVersion).toBe(9)
    }
  })
})
