// useOrgComments (AQU-1958). Pinned rules:
// - the org's project list is the access boundary: one comments read per listed
//   project, with a token minted for that project and nothing else;
// - a project whose read fails is reported by name and does not blank the rest;
// - nothing is read without an org and a session.

import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useOrgComments } from "./useOrgComments"
import type { CommentRecord } from "@/lib/sync/comments-read-types"

const fetchProjects = vi.hoisted(() => vi.fn())
const fetchCommentsForProject = vi.hoisted(() => vi.fn())
const buildFileScopedTokenFetcher = vi.hoisted(() => vi.fn())

vi.mock("@/lib/sync/cloud-projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/cloud-projects")>()
  return { ...actual, fetchAccessibleProjectsResult: fetchProjects }
})
vi.mock("@/lib/sync/comments-read", () => ({
  fetchCommentsForProject: (...args: unknown[]) => fetchCommentsForProject(...args),
}))
vi.mock("@/lib/sync/cqrs-bridge", () => ({
  buildFileScopedTokenFetcher: (...args: unknown[]) => buildFileScopedTokenFetcher(...args),
}))
vi.mock("@/lib/frontier/session-expiry", () => ({
  notifySessionExpiredIfCurrent: vi.fn(),
}))

function comment(projectId: string, commentId: string): CommentRecord {
  return {
    commentId,
    projectId,
    scopeKind: "cell",
    fileId: "f1",
    cellId: "cell-1",
    parentCommentId: null,
    body: commentId,
    resolved: false,
    authorId: "u1",
    authorLabel: "Anastasia",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  }
}

const listed = {
  ok: true as const,
  projects: [
    {
      id: "p-oromo",
      name: "Oromo NT",
      gitlabProjectId: null,
      role: { level: 600, name: "maintainer", source: "org" },
      files: [{ id: "f1", name: "Genesis", type: "usfm", cellCount: 3 }],
    },
    {
      id: "p-marathi",
      name: "Marathi NT",
      gitlabProjectId: null,
      role: { level: 600, name: "maintainer", source: "org" },
      files: [{ id: "f2", name: "Exodus", type: "usfm", cellCount: 4 }],
    },
  ],
}

describe("useOrgComments", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    buildFileScopedTokenFetcher.mockImplementation((_getJwt: unknown, projectId: string) =>
      async () => `tok-${projectId}`)
  })

  it("reads each listed project's comments with that project's own token", async () => {
    fetchProjects.mockResolvedValue(listed)
    fetchCommentsForProject.mockImplementation(async (projectId: string) =>
      [comment(projectId, `c-${projectId}`)])

    const hook = renderHook(() => useOrgComments({ orgId: 1, jwt: "jwt" }))

    await waitFor(() => expect(hook.result.current.comments).toHaveLength(2))
    expect(fetchProjects).toHaveBeenCalledWith("jwt", 1)
    expect(fetchCommentsForProject).toHaveBeenCalledWith("p-oromo", "tok-p-oromo")
    expect(fetchCommentsForProject).toHaveBeenCalledWith("p-marathi", "tok-p-marathi")
    // Only the listed projects — the list IS the access boundary.
    expect(fetchCommentsForProject).toHaveBeenCalledTimes(2)
    expect(hook.result.current.projects.map((p) => p.name)).toEqual(["Marathi NT", "Oromo NT"])
    expect(hook.result.current.projects[1].files).toEqual([{ id: "f1", name: "Genesis" }])
    expect(hook.result.current.failedProjects).toEqual([])
  })

  it("names a project whose read failed and keeps the others' comments", async () => {
    fetchProjects.mockResolvedValue(listed)
    fetchCommentsForProject.mockImplementation(async (projectId: string) => {
      if (projectId === "p-marathi") throw new Error("HTTP 403")
      return [comment(projectId, "c1")]
    })

    const hook = renderHook(() => useOrgComments({ orgId: 1, jwt: "jwt" }))

    await waitFor(() => expect(hook.result.current.failedProjects).toEqual(["Marathi NT"]))
    expect(hook.result.current.comments.map((c) => c.projectId)).toEqual(["p-oromo"])
    expect(hook.result.current.error).toBeNull()
  })

  it("surfaces a project-list failure as the error, with no comments read", async () => {
    fetchProjects.mockResolvedValue({ ok: false, reason: "forbidden", status: 403 })

    const hook = renderHook(() => useOrgComments({ orgId: 1, jwt: "jwt" }))

    await waitFor(() => expect(hook.result.current.error).toBeTruthy())
    expect(fetchCommentsForProject).not.toHaveBeenCalled()
    expect(hook.result.current.comments).toEqual([])
  })

  it("reads nothing without an org or a session", async () => {
    fetchProjects.mockResolvedValue(listed)

    const noOrg = renderHook(() => useOrgComments({ orgId: null, jwt: "jwt" }))
    await waitFor(() => expect(noOrg.result.current.isLoading).toBe(false))
    const noJwt = renderHook(() => useOrgComments({ orgId: 1, jwt: null }))
    await waitFor(() => expect(noJwt.result.current.isLoading).toBe(false))

    expect(fetchProjects).not.toHaveBeenCalled()
    expect(fetchCommentsForProject).not.toHaveBeenCalled()
  })
})
